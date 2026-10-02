---
"@trailstep/cli": minor
---

Split recommended-config consent out of the blanket `trailstep update` confirmation: when recommended config additions ride along with package/skill changes, a second prompt asks whether to apply them, and declining skips only the recommended config writes while the rest of the update proceeds.