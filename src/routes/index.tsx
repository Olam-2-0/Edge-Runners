import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Edit3,
  Gamepad2,
  ListTodo,
  Plus,
  RotateCcw,
  Settings,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { ArcadeButton } from "@/components/arcade-button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Edge Runners — Adaptive Study Arcade" },
      {
        name: "description",
        content:
          "Turn your workload into a flexible daily quest with an adaptive, encouraging study schedule.",
      },
      { property: "og:title", content: "Edge Runners — Adaptive Study Arcade" },
      {
        property: "og:description",
        content:
          "A responsive retro-arcade study planner that adapts to your time, pace, and capacity.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: EdgeRunners,
});

type Confidence = "struggling" | "average" | "strong";
type Difficulty = "easy" | "medium" | "hard";
type Priority = "low" | "medium" | "high" | "urgent" | "";
type Capacity = "low" | "neutral" | "high";
type TaskKind = "backlog" | "assignment" | "exam";
type Profile = {
  username: string;
  academicConfidence: Confidence;
  availability: Record<string, number>;
};
type Task = {
  id: string;
  kind: TaskKind;
  subject: string;
  title: string;
  difficulty: Difficulty;
  hours: number;
  due?: string | undefined;
  manualPriority: Priority;
  dependencies?: string[] | undefined;
  completed?: boolean | undefined;
  completedHours?: number;
  missedCount?: number;
  /** Specific (date, hours) pairs already cleared, so a finished day stays crossed off
   * instead of being re-scheduled or silently vanishing once its hours are credited. */
  clearedSessions?: { date: string; hours: number }[];
};
type Session = Task & {
  plannedHours: number;
  /** Real calendar date (YYYY-MM-DD) this session is scheduled on — not a rotating slot. */
  date: string;
  score: number;
  reason: string;
  sessionId: string;
  /** True once this exact session has been CLEARed — rendered crossed off, not removed. */
  cleared?: boolean;
};

const STORAGE_PROFILE = "studyScheduler.studentProfile";
const STORAGE_TASKS = "studyScheduler.tasks";
const STORAGE_DAY_OFFSET = "studyScheduler.dayOffset";
const MS_PER_DAY = 86400000;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEIGHTS = { urgency: 0.5, difficulty: 0.3, dependency: 0.2 };
const DEFAULT_AVAILABILITY = Object.fromEntries(DAYS.map((day) => [day, 1]));
const todayIso = new Date().toISOString().slice(0, 10);

// ---- Calendar-date helpers -------------------------------------------------
// Everything below anchors the schedule to REAL calendar dates instead of a
// rotating 0-6 slot, so day/week/month navigation and "next day" all move
// forward through actual time instead of an arbitrary re-shuffle.
function toISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDaysToIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function diffInDays(fromIso: string, toIsoDate: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIsoDate}T00:00:00Z`).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}
/** Mon-indexed weekday short name ("Mon".."Sun") for an ISO date string. */
function weekdayName(iso: string): string {
  const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay(); // Sun=0..Sat=6
  return DAYS[(jsDay + 6) % 7] ?? "Mon";
}
/** Monday of the week containing this ISO date. */
function startOfWeek(iso: string): string {
  const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay();
  const mondayOffset = (jsDay + 6) % 7;
  return addDaysToIso(iso, -mondayOffset);
}
function formatDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${weekdayName(iso)} ${d.getUTCDate()}`;
}

function priorityScore(task: Task, confidence: Confidence, all: Task[], nowMs: number) {
  const remaining = task.due ? Math.ceil((new Date(task.due).getTime() - nowMs) / MS_PER_DAY) : 14;
  const urgency = Math.max(0, Math.min(1, 1 - remaining / 14));
  const confidenceAdjust = confidence === "struggling" ? 0.15 : confidence === "strong" ? -0.1 : 0;
  const difficulty = Math.max(
    0,
    { easy: 0.3, medium: 0.6, hard: 1 }[task.difficulty] + confidenceAdjust,
  );
  const dependency = all.some((item) => item.dependencies?.includes(task.title)) ? 1 : 0;
  const computed =
    WEIGHTS.urgency * urgency + WEIGHTS.difficulty * difficulty + WEIGHTS.dependency * dependency;
  if (!task.manualPriority) return computed;
  const manual = { low: 0.25, medium: 0.5, high: 0.75, urgent: 1 }[task.manualPriority];
  return 0.6 * manual + 0.4 * computed;
}

// Sessions are generated from each task's REMAINING hours (hours - completedHours), never
// the task's full original hours. This is what makes a quest genuinely subdivided: clearing
// one session only credits that session's planned hours, so a 6-hour hard quest still needs
// several separate CLEARs (spread across days) instead of finishing in one click.
//
// Sessions are placed on REAL calendar dates (today, today+1, today+2, ...) using a simple
// day-by-day bin-pack against each day's availability budget. This is what makes CLEAR, NEXT
// DAY, and week/month navigation all agree with each other: a task's next open session always
// lands on the actual next day that has room, and advancing the day (or changing which task is
// active) can only ever move sessions forward in real time — never onto an unrelated day chosen
// by a task's position in a list.
function generateSchedule(
  tasks: Task[],
  profile: Profile,
  capacity: Capacity,
  dayOffset = 0,
): Session[] {
  const nowMs = Date.now() + dayOffset * MS_PER_DAY;
  const todayIsoDate = toISODate(nowMs);
  const sessions: Session[] = [];
  // Tracks hours already booked on each real date, shared across every task so higher-priority
  // quests fill a day's budget first and lower-priority ones spill onto the next open day.
  const dayBudgetUsed = new Map<string, number>();

  // Surface every already-CLEARed session first, exactly as it was cleared, so browsing back to
  // a finished day still shows the crossed-off quest instead of it disappearing once its hours
  // are credited. These also count against that date's budget below so future placement doesn't
  // double-book a day that already had work done on it.
  tasks.forEach((task) => {
    (task.clearedSessions ?? []).forEach((entry, i) => {
      sessions.push({
        ...task,
        score: 0,
        date: entry.date,
        plannedHours: entry.hours,
        sessionId: `${task.id}-cleared-${i}`,
        reason: "Cleared",
        cleared: true,
      });
      dayBudgetUsed.set(entry.date, (dayBudgetUsed.get(entry.date) ?? 0) + entry.hours);
    });
  });

  const active = tasks
    .filter((task) => task.hours - (task.completedHours ?? 0) > 0.001)
    .map((task) => ({
      task,
      score: priorityScore(task, profile.academicConfidence, tasks, nowMs),
      remainingHours: task.hours - (task.completedHours ?? 0),
    }))
    .sort((a, b) => b.score - a.score);

  const chosen = capacity === "low" ? active.slice(0, 2) : active;
  const factor = capacity === "low" ? 0.6 : capacity === "high" ? 1.2 : 1;
  const MAX_LOOKAHEAD_DAYS = 90;

  chosen.forEach(({ task, score, remainingHours }) => {
    const atRisk = (task.missedCount ?? 0) >= 3;
    const baseSize =
      task.difficulty === "hard" ? 1 : task.difficulty === "medium" ? 1.5 : remainingHours;
    // At-risk quests (3+ missed sessions) get split into half-size chunks so they're easier to start.
    const size = atRisk ? Math.max(0.5, baseSize / 2) : baseSize;
    const daysLeft = task.due
      ? Math.max(0, Math.ceil((new Date(task.due).getTime() - nowMs) / MS_PER_DAY))
      : null;
    let hoursLeft = remainingHours;
    let cursor = 0; // days ahead of today
    let sessionIndex = 0;
    // Max one session of THIS task per day (spreads a quest across multiple days instead of
    // dumping it all in one sitting), so we always advance the cursor after a successful place.
    while (hoursLeft > 0.001 && cursor < MAX_LOOKAHEAD_DAYS) {
      const date = addDaysToIso(todayIsoDate, cursor);
      // This task already has a cleared, crossed-off session on this date — don't schedule a
      // second one here, push the remaining hours to the next open day instead.
      const alreadyClearedThisDate = (task.clearedSessions ?? []).some((e) => e.date === date);
      if (alreadyClearedThisDate) {
        cursor += 1;
        continue;
      }
      const dayName = weekdayName(date);
      const dayBudgetTotal = (profile.availability[dayName] ?? 1) * factor;
      const used = dayBudgetUsed.get(date) ?? 0;
      const free = dayBudgetTotal - used;
      if (free > 0.001) {
        const rawPlanned = Math.min(size, free, hoursLeft);
        const plannedHours = Math.max(0.25, Math.round(rawPlanned * 4) / 4);
        sessions.push({
          ...task,
          score,
          date,
          plannedHours,
          sessionId: `${task.id}-${sessionIndex}`,
          reason:
            `${task.difficulty.toUpperCase()} quest · ${task.due ? `${daysLeft} days left` : "backlog progress"} · ${Math.round(score * 100)} priority` +
            (atRisk ? " · AT RISK — split smaller after misses" : ""),
        });
        dayBudgetUsed.set(date, used + plannedHours);
        hoursLeft -= plannedHours;
        sessionIndex += 1;
      }
      cursor += 1;
    }
  });

  // High energy: pull one extra low-difficulty quest forward onto today, clearly marked optional.
  if (capacity === "high") {
    const todayTaskIds = new Set(sessions.filter((s) => s.date === todayIsoDate).map((s) => s.id));
    const rank = { easy: 0, medium: 1, hard: 2 } as const;
    const bonus = active
      .filter(({ task }) => !todayTaskIds.has(task.id))
      .sort((a, b) => rank[a.task.difficulty] - rank[b.task.difficulty])[0];
    if (bonus) {
      const bonusHours = Math.max(0.25, Math.min(1, bonus.remainingHours));
      sessions.push({
        ...bonus.task,
        score: bonus.score,
        date: todayIsoDate,
        plannedHours: bonusHours,
        sessionId: `${bonus.task.id}-bonus`,
        reason: "BONUS · You've got capacity — added one optional quest",
      });
    }
  }

  return sessions;
}

function EdgeRunners() {
  const [hydrated, setHydrated] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dayOffset, setDayOffset] = useState(0);
  const [stage, setStage] = useState<"onboarding" | "setup" | "dashboard">("onboarding");
  useEffect(() => {
    const savedProfile = localStorage.getItem(STORAGE_PROFILE);
    const savedTasks = localStorage.getItem(STORAGE_TASKS);
    const savedOffset = localStorage.getItem(STORAGE_DAY_OFFSET);
    if (savedProfile) {
      setProfile(JSON.parse(savedProfile));
      setStage("dashboard");
    }
    if (savedTasks) setTasks(JSON.parse(savedTasks));
    if (savedOffset) setDayOffset(Number(savedOffset) || 0);
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
  }, [tasks, hydrated]);
  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_DAY_OFFSET, String(dayOffset));
  }, [dayOffset, hydrated]);

  const handleReset = () => {
    localStorage.removeItem(STORAGE_PROFILE);
    localStorage.removeItem(STORAGE_TASKS);
    localStorage.removeItem(STORAGE_DAY_OFFSET);
    setProfile(null);
    setTasks([]);
    setDayOffset(0);
    setStage("onboarding");
  };

  if (!hydrated)
    return (
      <div className="flex min-h-screen items-center justify-center font-display text-xs">
        LOADING PLAYER DATA...
      </div>
    );
  return (
    <main className="crt min-h-screen">
      <TopBar profile={profile} onSetup={() => setStage("setup")} />
      {stage === "onboarding" ? (
        <Onboarding
          onFinish={(next) => {
            setProfile(next);
            localStorage.setItem(STORAGE_PROFILE, JSON.stringify(next));
            setStage("setup");
          }}
        />
      ) : stage === "setup" ? (
        <TaskSetup tasks={tasks} setTasks={setTasks} onContinue={() => setStage("dashboard")} />
      ) : profile ? (
        <Dashboard
          profile={profile}
          tasks={tasks}
          setTasks={setTasks}
          dayOffset={dayOffset}
          setDayOffset={setDayOffset}
          onReset={handleReset}
          onSetup={() => setStage("setup")}
        />
      ) : null}
      <Footer />
    </main>
  );
}

function TopBar({ profile, onSetup }: { profile: Profile | null; onSetup: () => void }) {
  const [muted, setMuted] = useState(true);
  return (
    <header className="border-b-4 border-primary bg-background">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-4 md:px-8">
        <div className="flex items-center gap-3">
          <Gamepad2 className="size-8" aria-hidden="true" />
          <div>
            <p className="font-display text-sm leading-6 md:text-xl">EDGE RUNNERS</p>
            <p className="text-base text-muted-foreground">Adaptive Study Arcade</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {profile && (
            <ArcadeButton variant="ghost" onClick={onSetup} aria-label="Open task setup">
              <Plus className="size-4" />
              <span className="hidden sm:inline">TASKS</span>
            </ArcadeButton>
          )}
          <ArcadeButton
            variant="ghost"
            onClick={() => setMuted((value) => !value)}
            aria-label={muted ? "Turn sound hooks on" : "Mute sound hooks"}
          >
            {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </ArcadeButton>
        </div>
      </div>
    </header>
  );
}

function Onboarding({ onFinish }: { onFinish: (profile: Profile) => void }) {
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState("");
  const [confidence, setConfidence] = useState<Confidence>("average");
  const [availability, setAvailability] = useState<Record<string, number>>(DEFAULT_AVAILABILITY);
  return (
    <section className="mx-auto flex min-h-[calc(100vh-140px)] max-w-4xl items-center px-4 py-10">
      <div className="arcade-panel w-full p-5 md:p-10">
        <div className="mb-9 flex items-center justify-between gap-3">
          <div>
            <p className="font-display text-[10px] text-muted-foreground">NEW GAME</p>
            <h1 className="mt-3 font-display text-xl leading-9 md:text-3xl">PLAYER SETUP</h1>
          </div>
          <div className="flex gap-2" aria-label={`Step ${step + 1} of 3`}>
            {[0, 1, 2].map((item) => (
              <span
                key={item}
                className={`h-3 w-8 border-2 border-primary ${item <= step ? "bg-primary" : "bg-card"}`}
              />
            ))}
          </div>
        </div>
        {step === 0 && (
          <div className="animate-fade-in">
            <label className="font-display text-sm leading-7" htmlFor="username">
              WHAT SHOULD WE CALL YOU?
            </label>
            <input
              id="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="PLAYER ONE"
              className="mt-5 w-full border-2 border-primary bg-background p-4 text-3xl text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-3 text-muted-foreground">Your name appears on mission briefings.</p>
          </div>
        )}
        {step === 1 && (
          <div className="animate-fade-in">
            <h2 className="font-display text-sm leading-7">HOW IS ACADEMIC LIFE RIGHT NOW?</h2>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              {(["struggling", "average", "strong"] as Confidence[]).map((value) => {
                const isSelected = confidence === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setConfidence(value)}
                    aria-pressed={isSelected}
                    className={`relative min-h-28 border-2 p-4 text-left uppercase transition-all active:translate-x-1 active:translate-y-1 ${
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground shadow-[4px_4px_0_var(--card)] ring-2 ring-primary ring-offset-2 ring-offset-background"
                        : "border-card bg-secondary text-foreground hover:border-primary/60 hover:bg-card/40 shadow-[4px_4px_0_var(--card)]"
                    }`}
                  >
                    {isSelected && (
                      <Check
                        className="absolute right-3 top-3 size-5 text-primary-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className={`font-display text-[10px] ${isSelected ? "font-bold text-primary-foreground" : "text-foreground"}`}
                    >
                      {value}
                    </span>
                    <span
                      className={`mt-3 block text-base leading-5 ${isSelected ? "font-medium text-primary-foreground/90" : "text-muted-foreground"}`}
                    >
                      {value === "struggling"
                        ? "Smaller, steadier quests"
                        : value === "strong"
                          ? "A brisker mission pace"
                          : "Balanced mission pacing"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="animate-fade-in">
            <h2 className="font-display text-sm leading-7">SET DAILY STUDY POWER</h2>
            <p className="mt-2 text-muted-foreground">
              Choose available hours. Zero is okay; we’ll use a gentle one-hour default.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-7">
              {DAYS.map((day) => (
                <label key={day} className="arcade-card p-3 text-center">
                  <span className="font-display text-[9px]">{day}</span>
                  <input
                    type="number"
                    min="0"
                    max="12"
                    step="0.5"
                    value={availability[day]}
                    onChange={(event) =>
                      setAvailability((current) => ({
                        ...current,
                        [day]: Number(event.target.value),
                      }))
                    }
                    className="mt-3 w-full border-2 border-primary bg-background p-2 text-center text-2xl outline-none"
                  />
                  <span className="text-sm text-muted-foreground">HRS</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="mt-10 flex flex-wrap justify-between gap-3">
          {step > 0 ? (
            <ArcadeButton variant="secondary" onClick={() => setStep(step - 1)}>
              <ArrowLeft className="size-4" />
              BACK
            </ArcadeButton>
          ) : (
            <span />
          )}
          {step < 2 ? (
            <ArcadeButton
              onClick={() => setStep(step + 1)}
              disabled={step === 0 && !username.trim()}
            >
              CONTINUE
              <ChevronRight className="size-4" />
            </ArcadeButton>
          ) : (
            <ArcadeButton
              onClick={() =>
                onFinish({
                  username: username.trim() || "Player One",
                  academicConfidence: confidence,
                  availability: Object.fromEntries(
                    DAYS.map((day) => [day, availability[day] || 1]),
                  ),
                })
              }
            >
              BUILD MY PLAN
              <Zap className="size-4" />
            </ArcadeButton>
          )}
        </div>
      </div>
    </section>
  );
}

function TaskSetup({
  tasks,
  setTasks,
  onContinue,
}: {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  onContinue: () => void;
}) {
  const [panel, setPanel] = useState<TaskKind | "all">("backlog");
  const [form, setForm] = useState({
    subject: "",
    title: "",
    difficulty: "medium" as Difficulty,
    hours: 1,
    due: "",
    manualPriority: "" as Priority,
  });
  const addTask = () => {
    if (!form.subject.trim() || !form.title.trim()) return;
    setTasks((current) => [
      ...current,
      { ...form, id: crypto.randomUUID(), kind: panel === "all" ? "backlog" : panel },
    ]);
    setForm({
      subject: "",
      title: "",
      difficulty: "medium",
      hours: 1,
      due: "",
      manualPriority: "",
    });
  };
  const updateTask = (updated: Task) => {
    setTasks((current) => current.map((t) => (t.id === updated.id ? updated : t)));
  };
  const labels = { backlog: "BACKLOG", assignment: "ASSIGNMENT", exam: "EXAM", all: "ALL TASKS" };
  return (
    <section className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <div className="mb-8">
        <p className="font-display text-[10px] text-muted-foreground">MODE SELECT</p>
        <h1 className="mt-3 font-display text-2xl leading-10">CHOOSE YOUR QUESTS</h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <nav className="flex flex-col gap-3">
          {(["backlog", "assignment", "exam", "all"] as const).map((value) => (
            <ArcadeButton
              key={value}
              variant={panel === value ? "primary" : "secondary"}
              onClick={() => setPanel(value)}
              className="justify-start"
            >
              {value !== "all" ? <Plus className="size-4" /> : <ListTodo className="size-4" />}
              {labels[value]}
            </ArcadeButton>
          ))}
          <ArcadeButton onClick={onContinue} disabled={!tasks.length} className="mt-4">
            START RUN
            <ArrowRight className="size-4" />
          </ArcadeButton>
        </nav>
        <div className="arcade-panel min-h-[480px] p-5 md:p-8">
          {panel === "all" ? (
            <TaskList
              tasks={tasks}
              onUpdate={updateTask}
              onDelete={(id) => {
                if (confirm("Remove this quest?"))
                  setTasks((current) => current.filter((task) => task.id !== id));
              }}
            />
          ) : (
            <>
              <h2 className="font-display text-sm leading-7">ADD {labels[panel]}</h2>
              <div className="mt-6 grid gap-5 sm:grid-cols-2">
                <Field label="SUBJECT">
                  <input
                    value={form.subject}
                    onChange={(event) => setForm({ ...form, subject: event.target.value })}
                    placeholder="e.g. Physics"
                    className="arcade-input"
                  />
                </Field>
                <Field
                  label={panel === "backlog" ? "TOPIC" : panel === "exam" ? "EXAM TITLE" : "TITLE"}
                >
                  <input
                    value={form.title}
                    onChange={(event) => setForm({ ...form, title: event.target.value })}
                    placeholder="Mission name"
                    className="arcade-input"
                  />
                </Field>
                <Field label="DIFFICULTY">
                  <select
                    value={form.difficulty}
                    onChange={(event) =>
                      setForm({ ...form, difficulty: event.target.value as Difficulty })
                    }
                    className="arcade-input"
                  >
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </Field>
                <Field label="ESTIMATED HOURS">
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={form.hours}
                    onChange={(event) => setForm({ ...form, hours: Number(event.target.value) })}
                    className="arcade-input"
                  />
                </Field>
                {panel !== "backlog" && (
                  <Field label={panel === "exam" ? "EXAM DATE" : "DEADLINE"}>
                    <input
                      type="date"
                      min={todayIso}
                      value={form.due}
                      onChange={(event) => setForm({ ...form, due: event.target.value })}
                      className="arcade-input"
                    />
                  </Field>
                )}
                <Field label="PRIORITY BOOST (OPTIONAL)">
                  <select
                    value={form.manualPriority}
                    onChange={(event) =>
                      setForm({ ...form, manualPriority: event.target.value as Priority })
                    }
                    className="arcade-input"
                  >
                    <option value="">Auto</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </Field>
              </div>
              <ArcadeButton
                onClick={addTask}
                className="mt-7"
                disabled={!form.subject.trim() || !form.title.trim()}
              >
                <Plus className="size-4" />
                ADD QUEST
              </ArcadeButton>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="text-muted-foreground">
      <span className="mb-2 block font-display text-[9px] leading-5 text-foreground">{label}</span>
      {children}
    </label>
  );
}

function TaskEditForm({
  task,
  onSave,
  onCancel,
}: {
  task: Task;
  onSave: (updated: Task) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Task>({ ...task });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!form.subject.trim() || !form.title.trim()) return;
        onSave(form);
      }}
      className="arcade-card border-2 border-primary p-4 space-y-4 animate-fade-in"
    >
      <div className="flex items-center justify-between border-b border-card pb-2">
        <span className="font-display text-[10px] text-primary">EDIT QUEST DATA</span>
        <span className="font-display text-[8px] text-muted-foreground">
          ID: {task.id.slice(0, 8)}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        <Field label="TYPE">
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as TaskKind })}
            className="arcade-input"
          >
            <option value="backlog">Backlog</option>
            <option value="assignment">Assignment</option>
            <option value="exam">Exam</option>
          </select>
        </Field>
        <Field label="SUBJECT">
          <input
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            placeholder="e.g. Physics"
            className="arcade-input"
            required
          />
        </Field>
        <Field label="TITLE">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Mission title"
            className="arcade-input"
            required
          />
        </Field>
        <Field label="DIFFICULTY">
          <select
            value={form.difficulty}
            onChange={(e) => setForm({ ...form, difficulty: e.target.value as Difficulty })}
            className="arcade-input"
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </Field>
        <Field label="ESTIMATED HOURS">
          <input
            type="number"
            min="0.5"
            step="0.5"
            value={form.hours}
            onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}
            className="arcade-input"
            required
          />
        </Field>
        <Field label={form.kind === "exam" ? "EXAM DATE" : "DEADLINE"}>
          <input
            type="date"
            min={todayIso}
            value={form.due ?? ""}
            onChange={(e) => setForm({ ...form, due: e.target.value })}
            className="arcade-input"
          />
        </Field>
        <Field label="PRIORITY BOOST">
          <select
            value={form.manualPriority}
            onChange={(e) => setForm({ ...form, manualPriority: e.target.value as Priority })}
            className="arcade-input"
          >
            <option value="">Auto</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <ArcadeButton type="submit" disabled={!form.subject.trim() || !form.title.trim()}>
          <Check className="size-4" />
          SAVE QUEST
        </ArcadeButton>
        <ArcadeButton type="button" variant="ghost" onClick={onCancel}>
          <X className="size-4" />
          CANCEL
        </ArcadeButton>
      </div>
    </form>
  );
}

function TaskList({
  tasks,
  onUpdate,
  onDelete,
}: {
  tasks: Task[];
  onUpdate: (task: Task) => void;
  onDelete: (id: string) => void;
}) {
  const [filter, setFilter] = useState<TaskKind | "all">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const visible = filter === "all" ? tasks : tasks.filter((task) => task.kind === filter);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-sm">QUEST LOG</h2>
        <select
          aria-label="Filter tasks"
          value={filter}
          onChange={(event) => setFilter(event.target.value as TaskKind | "all")}
          className="arcade-input max-w-48"
        >
          <option value="all">All types</option>
          <option value="backlog">Backlog</option>
          <option value="assignment">Assignments</option>
          <option value="exam">Exams</option>
        </select>
      </div>
      <div className="mt-6 space-y-3">
        {visible.map((task) => {
          if (editingId === task.id) {
            return (
              <TaskEditForm
                key={task.id}
                task={task}
                onSave={(updated) => {
                  onUpdate(updated);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            );
          }
          return (
            <article
              key={task.id}
              className="arcade-card flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-[8px] text-muted-foreground uppercase">
                    {task.kind}
                  </span>
                  {task.manualPriority === "urgent" && (
                    <span className="bg-alert px-2 py-1 text-sm text-alert-foreground">URGENT</span>
                  )}
                  {task.manualPriority && task.manualPriority !== "urgent" && (
                    <span className="border border-primary/60 px-2 py-0.5 text-sm uppercase text-muted-foreground">
                      {task.manualPriority}
                    </span>
                  )}
                </div>
                <h3 className="mt-2 text-2xl leading-6 text-foreground truncate">
                  {task.subject}: {task.title}
                </h3>
                <p className="mt-1 text-muted-foreground">
                  {task.hours}h · {task.difficulty}
                  {task.due ? ` · Due ${task.due}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ArcadeButton
                  variant="ghost"
                  onClick={() => setEditingId(task.id)}
                  aria-label={`Edit ${task.title}`}
                >
                  <Edit3 className="size-4" />
                </ArcadeButton>
                <ArcadeButton
                  variant="ghost"
                  onClick={() => onDelete(task.id)}
                  aria-label={`Delete ${task.title}`}
                >
                  <Trash2 className="size-5" />
                </ArcadeButton>
              </div>
            </article>
          );
        })}
        {!visible.length && (
          <p className="py-16 text-center text-muted-foreground">NO QUESTS IN THIS ZONE</p>
        )}
      </div>
    </>
  );
}

function Dashboard({
  profile,
  tasks,
  setTasks,
  dayOffset,
  setDayOffset,
  onReset,
  onSetup,
}: {
  profile: Profile;
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  dayOffset: number;
  setDayOffset: React.Dispatch<React.SetStateAction<number>>;
  onReset: () => void;
  onSetup: () => void;
}) {
  const [capacity, setCapacity] = useState<Capacity>("neutral");
  const [view, setView] = useState<"day" | "week" | "month">("day");
  // Real-time cursors: dayCursor is "days from today", weekShift/monthShift are "weeks/months
  // from the current week/month". All three page through actual calendar time, so navigating
  // never re-shuffles the underlying schedule — it just changes which slice of it is shown.
  const [dayCursor, setDayCursor] = useState(0);
  const [weekShift, setWeekShift] = useState(0);
  const [monthShift, setMonthShift] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [missedBanner, setMissedBanner] = useState<string[]>([]);
  const [clearedBanner, setClearedBanner] = useState(false);
  const nowMs = Date.now() + dayOffset * MS_PER_DAY;
  const todayIsoDate = toISODate(nowMs);
  const schedule = useMemo(() => {
    const generated = generateSchedule(tasks, profile, capacity, dayOffset);
    if (capacity !== "low") return generated;
    const examOverrides = tasks
      .filter(
        (task) =>
          task.kind === "exam" && task.due && (new Date(task.due).getTime() - nowMs) / MS_PER_DAY <= 5,
      )
      .flatMap((task) => generateSchedule([task], profile, "neutral", dayOffset));
    return [
      ...generated,
      ...examOverrides.filter(
        (item) => !generated.some((existing) => existing.sessionId === item.sessionId),
      ),
    ].map((item) =>
      !item.cleared && examOverrides.some((exam) => exam.sessionId === item.sessionId)
        ? { ...item, reason: `${item.reason} · EXAM OVERRIDE` }
        : item,
    );
  }, [tasks, profile, capacity, dayOffset, nowMs]);
  const completed = tasks.filter((task) => task.hours - (task.completedHours ?? 0) <= 0.001).length;
  const power = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const backlog = tasks.filter(
    (task) => task.kind === "backlog" && task.hours - (task.completedHours ?? 0) > 0.001,
  ).length;
  const examMode = tasks.some(
    (task) => task.kind === "exam" && task.due && (new Date(task.due).getTime() - nowMs) / MS_PER_DAY <= 7,
  );
  // CLEAR now credits only that session's planned hours to the quest, not the whole quest.
  // A hard 6-hour quest split into six 1-hour sessions needs six CLEARs (across days) to finish.
  // The session's specific date is recorded on the task so that exact day stays crossed off —
  // it renders as done instead of quietly disappearing or getting rescheduled.
  const complete = (sessionId: string) => {
    const session = schedule.find((item) => item.sessionId === sessionId);
    if (!session || session.cleared) return;
    setTasks((current) =>
      current.map((task) => {
        if (task.id !== session.id) return task;
        const nextHours = Math.min(task.hours, (task.completedHours ?? 0) + session.plannedHours);
        return {
          ...task,
          completedHours: nextHours,
          completed: nextHours >= task.hours - 0.001,
          clearedSessions: [
            ...(task.clearedSessions ?? []),
            { date: session.date, hours: session.plannedHours },
          ],
        };
      }),
    );
  };
  const updateTask = (updated: Task) =>
    setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)));
  const remove = (id: string) => {
    if (confirm("Remove this quest?"))
      setTasks((current) => current.filter((task) => task.id !== id));
  };
  // Advancing the day is how missed quests get detected: anything still sitting in today's real
  // date that wasn't cleared is flagged as missed (+1 on that quest's missedCount, which
  // eventually splits it into smaller at-risk chunks). Because sessions are now dated for real
  // calendar days instead of a rotating slot, we don't need to manually redistribute anything —
  // the next schedule recompute is anchored on the new "today" and naturally places each task's
  // next open session there.
  const advanceDay = () => {
    const missedToday = schedule.filter(
      (session) => session.date === todayIsoDate && !session.cleared,
    );
    const missedIds = Array.from(new Set(missedToday.map((session) => session.id)));
    if (missedIds.length) {
      setTasks((current) =>
        current.map((task) =>
          missedIds.includes(task.id) ? { ...task, missedCount: (task.missedCount ?? 0) + 1 } : task,
        ),
      );
      setMissedBanner(missedToday.map((session) => `${session.subject}: ${session.title}`));
    } else {
      setMissedBanner([]);
    }
    setClearedBanner(false);
    setDayOffset((value) => value + 1);
    setDayCursor(0);
    setWeekShift(0);
    setMonthShift(0);
  };
  // Today's real sessions (independent of whichever day/week/month the student is currently
  // browsing) — used to detect "everything for today is cleared" and auto-advance.
  const todaysSessions = schedule.filter((session) => session.date === todayIsoDate);
  const allTodayCleared = todaysSessions.length > 0 && todaysSessions.every((session) => session.cleared);
  useEffect(() => {
    if (!allTodayCleared) {
      setClearedBanner(false);
      return;
    }
    setClearedBanner(true);
    const timer = setTimeout(() => advanceDay(), 1100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTodayCleared, todayIsoDate]);
  return (
    <section className="mx-auto max-w-[1440px] px-4 py-8 md:px-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-display text-[10px] text-muted-foreground">
            PLAYER: {profile.username}
          </p>
          <h1 className="mt-3 font-display text-xl leading-9 md:text-3xl">MISSION CONTROL</h1>
          <p className="mt-2 text-2xl">Your plan rebuilt from today’s time and energy.</p>
        </div>
        <div
          className={`border-2 px-4 py-3 font-display text-[9px] ${examMode ? "border-alert bg-alert text-alert-foreground scan-glow" : "border-primary bg-card"}`}
        >
          {examMode ? "⚠ EXAM MODE" : "NORMAL MODE"}
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <div className="arcade-panel p-4 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-display text-[9px] text-muted-foreground">
                  DAILY CHECK-IN · OPTIONAL
                </p>
                <h2 className="mt-2 text-2xl text-foreground">How much power do you have today?</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["low", "neutral", "high"] as Capacity[]).map((value) => (
                  <ArcadeButton
                    key={value}
                    variant={capacity === value ? "primary" : "secondary"}
                    onClick={() => setCapacity(value)}
                  >
                    {value}
                  </ArcadeButton>
                ))}
              </div>
            </div>
            {capacity === "low" && (
              <p className="mt-5 border-l-4 border-primary pl-4 text-foreground animate-fade-in">
                Plan lightened to 60% capacity. Only your two most useful quests remain in today’s
                queue.
              </p>
            )}
            {missedBanner.length > 0 && (
              <p className="mt-5 border-l-4 border-alert bg-alert/10 pl-4 py-2 text-foreground animate-fade-in">
                {missedBanner.length} quest{missedBanner.length > 1 ? "s" : ""} missed yesterday (
                {missedBanner.join(", ")}) — rescheduled into today's queue automatically, no
                penalty.
              </p>
            )}
            {clearedBanner && (
              <p className="mt-5 border-l-4 border-primary bg-primary/10 pl-4 py-2 text-foreground animate-fade-in">
                All of today's quests are cleared — advancing to {formatDayLabel(addDaysToIso(todayIsoDate, 1))}…
              </p>
            )}
          </div>
          <div className="arcade-panel p-4 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex gap-2">
                <ArcadeButton
                  variant={view === "day" ? "primary" : "secondary"}
                  onClick={() => setView("day")}
                >
                  DAY
                </ArcadeButton>
                <ArcadeButton
                  variant={view === "week" ? "primary" : "secondary"}
                  onClick={() => setView("week")}
                >
                  WEEK
                </ArcadeButton>
                <ArcadeButton
                  variant={view === "month" ? "primary" : "secondary"}
                  onClick={() => setView("month")}
                >
                  MONTH
                </ArcadeButton>
              </div>
              <ArcadeButton variant="secondary" onClick={advanceDay} aria-label="Advance to next day">
                <ArrowRight className="size-4" />
                NEXT DAY ▶
              </ArcadeButton>
              <div className="flex items-center gap-2">
                <ArcadeButton
                  variant="ghost"
                  onClick={() => {
                    if (view === "day") setDayCursor((value) => value - 1);
                    else if (view === "week") setWeekShift((value) => value - 1);
                    else setMonthShift((value) => value - 1);
                  }}
                  aria-label="Previous"
                >
                  <ArrowLeft className="size-4" />
                </ArcadeButton>
                <span className="min-w-28 text-center font-display text-[9px]">
                  {view === "day"
                    ? `${formatDayLabel(addDaysToIso(todayIsoDate, dayCursor))}${dayCursor === 0 ? " · TODAY" : ""}`
                    : view === "week"
                      ? weekShift === 0
                        ? "THIS WEEK"
                        : weekShift > 0
                          ? `WEEK +${weekShift}`
                          : `WEEK ${weekShift}`
                      : monthShift === 0
                        ? "THIS MONTH"
                        : monthShift > 0
                          ? `MONTH +${monthShift}`
                          : `MONTH ${monthShift}`}
                </span>
                <ArcadeButton
                  variant="ghost"
                  onClick={() => {
                    if (view === "day") setDayCursor((value) => value + 1);
                    else if (view === "week") setWeekShift((value) => value + 1);
                    else setMonthShift((value) => value + 1);
                  }}
                  aria-label="Next"
                >
                  <ArrowRight className="size-4" />
                </ArcadeButton>
              </div>
            </div>
            {view === "day" ? (
              (() => {
                const activeDate = addDaysToIso(todayIsoDate, dayCursor);
                // Pending quests first, cleared/crossed-off ones sink to the bottom so today's
                // remaining work is always what's on top.
                const daySessions = schedule
                  .filter((session) => session.date === activeDate)
                  .sort((a, b) => Number(a.cleared ?? false) - Number(b.cleared ?? false));
                return (
                  <div className="mt-6 space-y-4">
                    {daySessions.map((session) => (
                      <SessionCard
                        key={session.sessionId}
                        session={session}
                        editing={editing === session.sessionId}
                        setEditing={setEditing}
                        onComplete={complete}
                        onDelete={remove}
                        onUpdateTask={updateTask}
                      />
                    ))}
                    {!daySessions.length && <EmptyDay />}
                  </div>
                );
              })()
            ) : view === "week" ? (
              (() => {
                const weekStart = addDaysToIso(startOfWeek(todayIsoDate), weekShift * 7);
                const weekDates = Array.from({ length: 7 }, (_, i) => addDaysToIso(weekStart, i));
                return (
                  <div className="mt-6 grid gap-3 lg:grid-cols-7">
                    {weekDates.map((date) => (
                      <div key={date} className="min-h-44 border-2 border-card bg-background p-3">
                        <h3 className="font-display text-[9px] text-primary">
                          {weekdayName(date)}
                          {date === todayIsoDate && " · TODAY"}
                        </h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {new Date(`${date}T00:00:00Z`).getUTCDate()}
                        </p>
                        <div className="mt-3 space-y-2">
                          {schedule
                            .filter((item) => item.date === date)
                            .map((item) => (
                              <button
                                key={item.sessionId}
                                onClick={() => {
                                  setDayCursor(diffInDays(todayIsoDate, date));
                                  setView("day");
                                }}
                                className="w-full border-l-4 border-primary bg-card p-2 text-left text-lg leading-5 text-foreground hover:bg-secondary"
                              >
                                {item.title}
                                <span className="mt-1 block text-sm text-muted-foreground">
                                  {item.plannedHours}h
                                </span>
                              </button>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()
            ) : (
              (() => {
                const cursorMs = new Date(`${todayIsoDate}T00:00:00Z`);
                const viewedYear = cursorMs.getUTCFullYear();
                const viewedMonth = cursorMs.getUTCMonth() + monthShift;
                const firstOfMonth = new Date(Date.UTC(viewedYear, viewedMonth, 1));
                const daysInMonth = new Date(Date.UTC(viewedYear, viewedMonth + 1, 0)).getUTCDate();
                const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
                const monthDates = Array.from({ length: daysInMonth }, (_, i) =>
                  new Date(Date.UTC(viewedYear, viewedMonth, i + 1)).toISOString().slice(0, 10),
                );
                return (
                  <div>
                    <p className="mt-6 font-display text-[9px] text-primary">
                      {MONTH_NAMES[((viewedMonth % 12) + 12) % 12]} {firstOfMonth.getUTCFullYear()}
                    </p>
                    <div className="mt-3 grid grid-cols-7 gap-2 text-center font-display text-[7px] text-muted-foreground">
                      {DAYS.map((d) => (
                        <span key={d}>{d}</span>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-7 gap-2">
                      {Array.from({ length: leadingBlanks }).map((_, i) => (
                        <div key={`blank-${i}`} />
                      ))}
                      {monthDates.map((date) => {
                        const daySessions = schedule.filter((item) => item.date === date);
                        return (
                          <button
                            key={date}
                            onClick={() => {
                              setDayCursor(diffInDays(todayIsoDate, date));
                              setView("day");
                            }}
                            className={`min-h-20 border-2 p-2 text-left align-top hover:bg-secondary ${
                              date === todayIsoDate
                                ? "border-primary bg-primary/10"
                                : "border-card bg-background"
                            }`}
                          >
                            <span className="text-sm text-muted-foreground">
                              {Number(date.slice(8, 10))}
                            </span>
                            {daySessions.length > 0 && (
                              <span className="mt-1 block text-sm text-foreground">
                                {daySessions.length} quest{daySessions.length > 1 ? "s" : ""}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </div>
        <aside className="space-y-5">
          <Meter
            title="POWER METER"
            value={power}
            detail={`${completed}/${tasks.length} quests cleared`}
            icon={<Zap className="size-5" />}
          />
          <Meter
            title="BOSS BAR"
            value={Math.max(8, 100 - backlog * 20)}
            detail={`${backlog} backlog quests remain`}
            icon={<Activity className="size-5" />}
          />
          <div className="arcade-panel p-5">
            <div className="flex items-center gap-3">
              <CircleHelp className="size-5" />
              <h2 className="font-display text-[10px]">WHY THIS PLAN?</h2>
            </div>
            <p className="mt-4 text-xl leading-6 text-muted-foreground">
              Urgency drives 50% of rank, difficulty 30%, and dependencies 20%.{" "}
              {profile.academicConfidence === "struggling"
                ? "Difficulty is weighted gently upward for smaller sessions."
                : profile.academicConfidence === "strong"
                  ? "Difficulty is weighted slightly down for a faster pace."
                  : "Your baseline stays balanced."}{" "}
              {capacity === "low"
                ? "Low energy today trims the plan to your top 2 quests at 60% pace."
                : capacity === "high"
                  ? "High energy adds 20% more room today, plus one bonus quest pulled forward."
                  : "Neutral energy keeps your normal daily pace."}{" "}
              A quest left uncleared when you hit NEXT DAY isn't lost — it's automatically folded
              back into today's queue, no penalty, and gets split into smaller chunks after
              repeated misses.
            </p>
          </div>
          <div className="arcade-panel p-5">
            <p className="font-display text-[10px]">LEVEL {Math.floor(completed / 2) + 1}</p>
            <p className="mt-3 text-xl text-muted-foreground">
              {completed < 2
                ? "Clear two quests to unlock the next level badge."
                : "Checkpoint unlocked. Keep your pace, not a streak."}
            </p>
          </div>
          <ArcadeButton variant="secondary" className="w-full" onClick={onSetup}>
            <Plus className="size-4" />
            MANAGE QUESTS
          </ArcadeButton>
          <ArcadeButton variant="ghost" className="w-full" onClick={onReset}>
            <RotateCcw className="size-4" />
            RESET PROFILE
          </ArcadeButton>
        </aside>
      </div>
    </section>
  );
}

function SessionCard({
  session,
  editing,
  setEditing,
  onComplete,
  onDelete,
  onUpdateTask,
}: {
  session: Session;
  editing: boolean;
  setEditing: (id: string | null) => void;
  onComplete: (sessionId: string) => void;
  onDelete: (id: string) => void;
  onUpdateTask: (task: Task) => void;
}) {
  const [form, setForm] = useState<Task>({
    id: session.id,
    kind: session.kind,
    subject: session.subject,
    title: session.title,
    difficulty: session.difficulty,
    hours: session.hours,
    due: session.due ?? "",
    manualPriority: session.manualPriority,
    dependencies: session.dependencies,
    completed: session.completed,
  });

  useEffect(() => {
    setForm({
      id: session.id,
      kind: session.kind,
      subject: session.subject,
      title: session.title,
      difficulty: session.difficulty,
      hours: session.hours,
      due: session.due ?? "",
      manualPriority: session.manualPriority,
      dependencies: session.dependencies,
      completed: session.completed,
    });
  }, [session]);

  const cleared = session.cleared ?? false;
  return (
    <article
      className={`arcade-card p-4 md:p-5 ${cleared ? "border-primary/60 bg-primary/5 opacity-80" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <span className="border border-primary px-2 text-sm uppercase">{session.kind}</span>
            {cleared && (
              <span className="flex items-center gap-1 bg-primary px-2 text-sm text-primary-foreground">
                <Check className="size-3" />
                CLEARED
              </span>
            )}
            {session.manualPriority === "urgent" && (
              <span className="bg-alert px-2 text-sm text-alert-foreground">URGENT</span>
            )}
            {session.manualPriority && session.manualPriority !== "urgent" && (
              <span className="border border-primary/60 px-2 text-sm uppercase text-muted-foreground">
                {session.manualPriority}
              </span>
            )}
            {(session.missedCount ?? 0) >= 3 && (
              <span className="bg-alert px-2 text-sm text-alert-foreground">AT RISK</span>
            )}
          </div>
          <h3
            className={`mt-3 text-3xl leading-7 ${cleared ? "text-muted-foreground line-through decoration-2" : "text-foreground"}`}
          >
            {session.subject}: {session.title}
          </h3>
          {session.hours > session.plannedHours && (
            <p className="mt-1 text-lg text-muted-foreground">
              {(session.completedHours ?? 0).toFixed(2).replace(/\.00$/, "")}h / {session.hours}h
              done overall — this quest is split across several sessions
            </p>
          )}
          <p className="mt-2 text-lg text-muted-foreground">
            {cleared ? "Cleared for this day — nice work." : session.reason}
          </p>
          {!cleared && (
            <details className="mt-3 text-muted-foreground">
              <summary className="cursor-pointer text-lg text-primary">Priority breakdown</summary>
              <p className="mt-2">
                Final score {Math.round(session.score * 100)} · urgency 50% · difficulty 30% ·
                dependency 20%
                {session.manualPriority ? ` · ${session.manualPriority} boost blended 60/40` : ""}
              </p>
            </details>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-2 text-right">
            <span className="font-display text-lg">{session.plannedHours}H</span>
            <span className="block text-sm text-muted-foreground">
              {cleared ? "CLEARED" : "TODAY"}
            </span>
          </div>
          {!cleared && (
            <ArcadeButton
              variant="ghost"
              onClick={() => setEditing(editing ? null : session.sessionId)}
              aria-label={`Edit ${session.title}`}
            >
              <Edit3 className="size-4" />
            </ArcadeButton>
          )}
          <ArcadeButton
            variant="ghost"
            onClick={() => onDelete(session.id)}
            aria-label={`Delete ${session.title}`}
          >
            <Trash2 className="size-4" />
          </ArcadeButton>
          {!cleared && (
            <ArcadeButton onClick={() => onComplete(session.sessionId)}>
              <Check className="size-4" />
              CLEAR
            </ArcadeButton>
          )}
        </div>
      </div>

      {editing && !cleared && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.subject.trim() || !form.title.trim()) return;
            onUpdateTask(form);
            setEditing(null);
          }}
          className="mt-5 border-t-2 border-card pt-5 animate-fade-in"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="font-display text-[9px] text-primary">EDIT QUEST DATA</p>
            <span className="font-display text-[8px] text-muted-foreground">
              ID: {session.id.slice(0, 8)}
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="TYPE">
              <select
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as TaskKind })}
                className="arcade-input"
              >
                <option value="backlog">Backlog</option>
                <option value="assignment">Assignment</option>
                <option value="exam">Exam</option>
              </select>
            </Field>
            <Field label="SUBJECT">
              <input
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                className="arcade-input"
                required
              />
            </Field>
            <Field label="TITLE">
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="arcade-input"
                required
              />
            </Field>
            <Field label="DIFFICULTY">
              <select
                value={form.difficulty}
                onChange={(e) => setForm({ ...form, difficulty: e.target.value as Difficulty })}
                className="arcade-input"
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </Field>
            <Field label="TOTAL HOURS">
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={form.hours}
                onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}
                className="arcade-input"
                required
              />
            </Field>
            <Field label={form.kind === "exam" ? "EXAM DATE" : "DEADLINE"}>
              <input
                type="date"
                min={todayIso}
                value={form.due ?? ""}
                onChange={(e) => setForm({ ...form, due: e.target.value })}
                className="arcade-input"
              />
            </Field>
            <Field label="PRIORITY BOOST">
              <select
                value={form.manualPriority}
                onChange={(e) => setForm({ ...form, manualPriority: e.target.value as Priority })}
                className="arcade-input"
              >
                <option value="">Auto</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <ArcadeButton type="submit">
              <Check className="size-4" />
              SAVE QUEST
            </ArcadeButton>
            <ArcadeButton type="button" variant="ghost" onClick={() => setEditing(null)}>
              <X className="size-4" />
              CANCEL
            </ArcadeButton>
          </div>
        </form>
      )}
    </article>
  );
}
function EmptyDay() {
  return (
    <div className="border-2 border-dashed border-card py-16 text-center">
      <CalendarDays className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-4 font-display text-[10px]">RECOVERY ZONE</p>
      <p className="mt-2 text-muted-foreground">No quests scheduled. Recharge freely.</p>
    </div>
  );
}
function Meter({
  title,
  value,
  detail,
  icon,
}: {
  title: string;
  value: number;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="arcade-panel p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {icon}
          <h2 className="font-display text-[10px]">{title}</h2>
        </div>
        <span className="font-display text-sm">{value}%</span>
      </div>
      <div className="mt-5 h-6 border-2 border-primary bg-background p-1">
        <div
          className="pixel-bar h-full transition-[width] duration-500"
          style={{ width: `${value}%` }}
        />
      </div>
      <p className="mt-3 text-muted-foreground">{detail}</p>
    </div>
  );
}
function Footer() {
  return (
    <footer className="border-t-2 border-card px-4 py-5 text-center text-lg text-muted-foreground">
      <span className="font-display text-[8px] text-primary">EDGE RUNNERS</span> · Created by Monish
      Chandra
    </footer>
  );
}
