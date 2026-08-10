for (const key of Object.keys(process.env)) {
  if (key.startsWith("TRAILSTEP_")) {
    delete process.env[key];
  }
}
