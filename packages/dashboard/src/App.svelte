<script lang="ts">
import { onMount } from "svelte";

import { connectRunEventStream, fetchDashboardRuns } from "./events/connector";
import type { DashboardEventRow } from "./events/reducer";
import type { DashboardRunSummary } from "./server/runs";

let runs: readonly DashboardRunSummary[] = [];
let selectedRunId = "";
let status = "No local StepKit runs found.";
let rows: readonly DashboardEventRow[] = [];
let stopStreaming: (() => void) | undefined;

void runs;
void selectedRunId;
void status;
void rows;

function connectToRun(run: DashboardRunSummary): void {
  selectedRunId = run.runId;
  status = `Selected run ${run.runId} is ${run.status}.`;
  rows = [];
  stopStreaming?.();
  stopStreaming = connectRunEventStream({
    runId: run.runId,
    onState: (state) => {
      rows = state.rows;
    },
  });
}

function handleRunChange(event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  const run = runs.find((candidate) => candidate.runId === select.value);
  if (run) {
    connectToRun(run);
  }
}

void handleRunChange;

onMount(() => {
  let disposed = false;

  const load = async () => {
    try {
      const loadedRuns = await fetchDashboardRuns();
      if (disposed) {
        return;
      }

      runs = loadedRuns;
      const latestRun = loadedRuns[0];
      if (latestRun) {
        connectToRun(latestRun);
      }
    } catch (error) {
      status = error instanceof Error ? error.message : "Unable to load local StepKit runs.";
    }
  };

  void load();

  return () => {
    disposed = true;
    stopStreaming?.();
  };
});
</script>

<main aria-labelledby="dashboard-title">
  <h1 id="dashboard-title">StepKit Local Runs</h1>
  <p>Read-only local dashboard for live local StepKit events from .stepkit/runs.</p>

  <section aria-labelledby="run-list-title">
    <h2 id="run-list-title">Local runs</h2>
    {#if runs.length > 0}
      <label for="run-select">Selected run</label>
      <select
        id="run-select"
        bind:value={selectedRunId}
        aria-describedby="run-status"
        onchange={handleRunChange}
      >
        {#each runs as run}
          <option value={run.runId}>{run.runId}</option>
        {/each}
      </select>
    {:else}
      <p>No runs found under <code>.stepkit/runs</code>.</p>
    {/if}
    <p id="run-status" aria-live="polite">{status}</p>
  </section>

  <section aria-labelledby="event-stream-title">
    <h2 id="event-stream-title">Live event stream</h2>
    {#if rows.length > 0}
      <table>
        <thead>
          <tr>
            <th scope="col">Timestamp</th>
            <th scope="col">Type</th>
            <th scope="col">Step</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row}
            <tr>
              <td>{row.timestamp}</td>
              <td>{row.type}</td>
              <td>{row.stepId ?? "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p>Waiting for events from the selected local run.</p>
    {/if}
  </section>
</main>
