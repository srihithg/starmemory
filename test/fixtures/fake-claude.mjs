// Stands in for the Claude Code executable the Agent SDK starts: records the
// command line, working folder and prompt it was given to FAKE_CLAUDE_LOG,
// answers the SDK's control requests, and replies to the prompt with one
// summary. No network.
import fs from 'node:fs';

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === 'control_request') {
      process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })}\n`);
    } else if (message.type === 'user') {
      const content = message.message?.content;
      const prompt = typeof content === 'string' ? content : (content ?? []).map((block) => block.text ?? '').join('');
      fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, guard: process.env.STARMEMORY_SUMMARIZER_GUARD })}\n`);
      const result = { type: 'result', subtype: 'success', is_error: false, result: '<summary>The user fixed a race.</summary>', session_id: 'fake', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      setTimeout(() => process.exit(0), 20);
    }
  }
});
