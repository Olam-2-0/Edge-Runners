# Adaptive Study Scheduler — Retro Arcade Build

Name of the project should be Edge Runners

mention the creators name : Monish Chandra, Aron George Daniel

## Goal

Build the complete self-contained study scheduler from the uploaded brief as a lively, easy-to-use arcade interface. The experience remains encouraging: no guilt language, failure states, streak loss, or pressure mechanics.

## Experience

- Create a one-time “New Game” onboarding flow for name, academic confidence, and weekly availability, with sensible defaults and local browser persistence.
- Build a mode-select task setup screen for backlog tasks, assignments, exams, task filtering, and confirmed deletion.
- Build the main schedule dashboard with day/week views, previous/next week controls, optional capacity check-in, schedule explanations, inline task controls, and profile reset.
- Present progress as a Power Meter, backlog as a Boss Bar, and weekly milestones as levels.
- Add restrained scanlines, crisp pixel borders, pressed-button feedback, small entrance transitions, and muted-by-default sound hooks.

## Scheduling behavior

- Implement the supplied deterministic priority formula, confidence adjustment, manual-priority blend, dependency boost, and difficulty-aware session splitting.
- Recalculate from current profile, tasks, logs, manual edits, and capacity whenever relevant state changes.
- Support low/neutral/high capacity, neutral rescheduling of missed work, at-risk topic chunking, exam mode, editable sessions, completion logging, and clear “why this changed” text.
- Seed realistic demo tasks and history so charts and schedule states are useful immediately; preserve user-added data locally after onboarding.

## Visual system

- Use only the five supplied colors: black, deep indigo, dark violet, muted teal, and alert red.
- Use Press Start 2P for display text and VT323 for readable interface text.
- Keep chunky 2–4px borders, hard offset shadows, large controls, visible focus states, and responsive layouts.
- Reserve red only for urgent and exam alerts; all missed or moved work stays calm teal/neutral.

## Verification

- Check onboarding persistence and reset.
- Exercise add/delete flows for all task types.
- Verify capacity changes, task completion/editing, day/week switching, and schedule explanations.
- Inspect desktop and mobile layouts for clipping, overlap, readability, and interaction clarity
  **Use the HTML file attached**
