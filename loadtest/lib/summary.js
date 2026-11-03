import { ROUTES } from './api.js';

function metric(data, name) {
  return data.metrics[name] ? data.metrics[name].values : undefined;
}

function ms(value, samples) {
  return value === undefined || samples === 0 ? '-' : `${Math.round(value)} ms`;
}

function pct(value) {
  return value === undefined ? '-' : `${(value * 100).toFixed(2)}%`;
}

function failedThresholds(data) {
  const failed = [];
  for (const [name, entry] of Object.entries(data.metrics)) {
    for (const [rule, result] of Object.entries(entry.thresholds || {})) {
      if (!result.ok) failed.push(`${name}: ${rule}`);
    }
  }
  return failed;
}

// The run's result as Markdown, laid out like one step of report-template.md, so it can be pasted
// into the report. The full k6 data goes to a JSON file beside it.
export function summaryMarkdown(data, { config, runId, holdEndpoints, wholeRunEndpoints }) {
  const lines = [];
  const failed = failedThresholds(data);
  const holdRequests = metric(data, 'http_reqs{phase:hold}');
  lines.push(`## Run ${runId}`);
  lines.push('');
  lines.push(`- Target: ${config.baseUrl}`);
  lines.push(
    `- Guests on this machine: ${config.guests} (accounts ${config.accountOffset} to ${
      config.accountOffset + config.guests - 1
    }), ramp ${config.rampSeconds} s, settle ${config.settleSeconds} s, hold ${config.holdSeconds} s`,
  );
  lines.push(
    `- Uploads: ${config.uploads ? `${config.uploadsPerMinute} a minute per event` : 'off'}`,
  );
  lines.push(`- Realtime: ${config.realtime ? 'on' : 'off'}`);
  lines.push(
    `- Requests a second in the hold: ${
      holdRequests ? (holdRequests.count / config.holdSeconds).toFixed(1) : '-'
    }`,
  );
  lines.push(`- Result: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} thresholds)`}`);
  lines.push('');
  lines.push('| Endpoint | Window | Requests | P95 | P99 | Errors |');
  lines.push('|---|---|---|---|---|---|');
  const row = (ep, window, suffix) => {
    const duration = metric(data, `http_req_duration{ep:${ep}${suffix}}`);
    const failures = metric(data, `http_req_failed{ep:${ep}${suffix}}`);
    lines.push(
      `| ${ROUTES[ep]} | ${window} | ${duration ? duration.count : 0} | ${ms(
        duration && duration['p(95)'],
        duration && duration.count,
      )} | ${ms(duration && duration['p(99)'], duration && duration.count)} | ${pct(
        failures && failures.rate,
      )} |`,
    );
  };
  for (const ep of holdEndpoints) row(ep, 'hold', ',phase:hold');
  for (const ep of wholeRunEndpoints) row(ep, 'whole run', '');
  lines.push('');
  if (config.realtime) {
    const join = metric(data, 'realtime_join_ok');
    const joinTime = metric(data, 'realtime_join_duration');
    const closes = metric(data, 'realtime_server_closes');
    const errors = metric(data, 'realtime_channel_errors');
    const lag = metric(data, 'realtime_delivery_lag{phase:hold}');
    const messages = metric(data, 'realtime_media_messages{phase:hold}');
    lines.push('| Realtime | Value |');
    lines.push('|---|---|');
    lines.push(
      `| Joins that succeeded | ${pct(join && join.rate)} of ${join ? join.passes + join.fails : 0} |`,
    );
    lines.push(`| Join reply P95 | ${ms(joinTime && joinTime['p(95)'])} |`);
    lines.push(`| Sockets the server closed | ${closes ? closes.count : 0} |`);
    lines.push(`| Channel errors | ${errors ? errors.count : 0} |`);
    lines.push(
      `| Delivery lag P95 / P99 (hold) | ${ms(lag && lag['p(95)'])} / ${ms(lag && lag['p(99)'])} |`,
    );
    lines.push(
      `| Media messages a second to these phones (hold) | ${
        messages ? (messages.count / config.holdSeconds).toFixed(1) : '-'
      } |`,
    );
    lines.push('');
  }
  if (config.uploads) {
    const done = metric(data, 'uploads_completed{phase:hold}');
    const failures = metric(data, 'upload_failures');
    lines.push(
      `Uploads completed in the hold: ${done ? done.count : 0}. Upload failures, any phase: ${
        failures ? failures.count : 0
      }.`,
    );
    lines.push('');
  }
  if (failed.length) {
    lines.push('Failed thresholds:');
    lines.push('');
    for (const entry of failed) lines.push(`- \`${entry}\``);
    lines.push('');
  }
  return lines.join('\n');
}
