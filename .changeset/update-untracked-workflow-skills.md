---
"@trailstep/cli": minor
---

`trailstep update` now picks up skills for new workflow exports of already-installed workflow packages: workflow exports without registry entries ("untracked workflows") get generated skills written to `.trailstep/skills/`, run via their package bundle ref, and distributed after workflow package installs. Untracked workflow skills are distributed only to the skill target(s) the user chose at `trailstep add` time (persisted per registration in workflow metadata). For legacy registrations without a recorded choice, update infers the targets from where that package's skills already exist (project vs. user skill directory) and otherwise defaults to project-only, reporting what was chosen.
