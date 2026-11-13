---
"@trailstep/core": patch
---

Run-identifier validation no longer applies a polynomial regular expression to caller-supplied names. The reserved-entry check, bare-name normalisation and alias-path comparison trim trailing dots and spaces with a linear scan instead of `/[. ]+$/u`, so a long run of dots or spaces can no longer stall run creation, resolution or storage operations. The accepted and rejected identifiers are unchanged.
