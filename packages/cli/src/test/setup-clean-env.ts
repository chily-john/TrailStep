for (const key of Object.keys(process.env)) {
  if (key.startsWith("TRAILSTEP_") || key.startsWith("STEPKIT_")) {
    delete process.env[key];
  }
}
