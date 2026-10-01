// What a summary request may carry: a conversation's words with the secrets
// people paste into sessions taken out. Every value below is made up.
import { describe, it, expect } from 'vitest';
import { REDACTED, redactSecrets } from '../src/redact.js';

describe('redactSecrets', () => {
  it('takes out tokens whose shape gives them away', () => {
    const tokens = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
      'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx',
      'sk_live_AbCdEfGhIjKlMnOp1234',
      'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'github_pat_11AbCdEfGhIjKlMnOpQrSt',
      'glpat-AbCdEfGhIjKlMnOpQrSt',
      'xoxb-1234567890-AbCdEfGhIj',
      'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456',
      'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ];
    for (const token of tokens) {
      const text = redactSecrets(`use ${token} for it`);
      expect(text).toBe(`use ${REDACTED} for it`);
    }
  });

  it('keeps the name of a setting and takes out its value, in the usual spellings', () => {
    const cases: [string, string][] = [
      ['export DB_PASSWORD=hunter2-acme', 'export DB_PASSWORD=[redacted]'],
      ['"aws.s3.secret_key" = "abcd1234efgh"', '"aws.s3.secret_key" = [redacted]'],
      ['fs.s3a.secret.key=abcd1234', 'fs.s3a.secret.key=[redacted]'],
      ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AWS_SECRET_ACCESS_KEY=[redacted]'],
      ['{"clientSecret": "s3cr3t-value"}', '{"clientSecret": [redacted]}'],
      ['api-key: 12345678', 'api-key: [redacted]'],
      ['db_pass=hunter2 basic_auth: user:hunter2', 'db_pass=[redacted] basic_auth: [redacted]'],
      ['the password is hunter2.', 'the password is [redacted].'],
    ];
    for (const [text, expected] of cases) expect(redactSecrets(text)).toBe(expected);
  });

  it('takes out credentials in URLs, headers, SQL and command lines', () => {
    const cases: [string, string][] = [
      ['mysql://admin:hunter2@db.example:3306/prod', 'mysql://admin:[redacted]@db.example:3306/prod'],
      ['curl -H "Authorization: Bearer abc.def.ghi123" https://api.example', 'curl -H "Authorization: Bearer [redacted]" https://api.example'],
      ['Cookie: session=abc123; theme=dark', 'Cookie: [redacted]'],
      ["CREATE USER 'app'@'%' IDENTIFIED BY 'hunter2';", "CREATE USER 'app'@'%' IDENTIFIED BY [redacted];"],
      ["SET PASSWORD FOR app = PASSWORD('hunter2')", "SET PASSWORD FOR app = PASSWORD('[redacted]')"],
      ['mysql -h db -u root -phunter2 prod', 'mysql -h db -u root -p[redacted] prod'],
      ['redis-cli -h cache -a hunter2 ping', 'redis-cli -h cache -a [redacted] ping'],
      ['sshpass -p hunter2 ssh host', 'sshpass -p [redacted] ssh host'],
      ['curl -u admin:hunter2 https://x.example', 'curl -u admin:[redacted] https://x.example'],
      ['psql --password=hunter2', 'psql --password=[redacted]'],
      ['DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abc123==;', 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=[redacted];'],
      ['https://hooks.slack.com/services/T000/B000/XXXX', 'https://hooks.slack.com/services/[redacted]'],
    ];
    for (const [text, expected] of cases) expect(redactSecrets(text)).toBe(expected);
  });

  it('takes out a private key whole, even one the text cuts off', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';

    expect(redactSecrets(`key:\n${key}\ndone`)).toBe('key:\n[redacted private key]\ndone');
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow')).toBe('[redacted private key]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Basic authentication failed twice, so we rotated the key and reran the compaction on tablet 1234.';

    expect(redactSecrets(text)).toBe(text);
  });
});
