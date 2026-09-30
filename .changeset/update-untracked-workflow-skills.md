---
"@trailstep/cli": minor
---

`trailstep update` now picks up skills for new workflow exports of already-installed workflow packages: workflow exports without registry entries ("untracked workflows") get generated skills written to `.trailstep/skills/`, run via their package bundle ref, and distributed to project and user skill targets after workflow package installs.
