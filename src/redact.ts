// Secrets out of text that leaves this machine. A summary request sends a
// conversation's words to the model provider, and people paste credentials
// into sessions. Each rule keeps what says which secret it was (the setting's
// name, the header, the user in a URL) and replaces only the secret itself.
// Best effort: the rules match the shapes credentials usually take, and a
// password written as plain prose can still get through.

export const REDACTED = '[redacted]';

/** A name that says its value is a secret, as settings and code spell it:
 * DB_PASSWORD, aws.s3.secret_key, clientSecret, api-key, basic_auth. */
const SECRET_NAME =
  '(?:[A-Za-z0-9_.-]*(?:passw(?:or)?d|passphrase|pwd|secret|secret[_.-]?key|token|api[_.-]?key|access[_.-]?key|private[_.-]?key|account[_.-]?key|shared[_.-]?key|credentials?)s?|(?:[A-Za-z0-9_.-]*[_.-])?(?:pass|auth))';

/** A quoted value, or one that runs to the next space or delimiter. */
const VALUE = `(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;'"}]+)`;

const RULES: [RegExp, string][] = [
  // A private key, whole, or up to where the text stops.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  // Tokens whose shape gives them away.
  [
    /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
    REDACTED,
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/g, `$1${REDACTED}`],
  // HTTP credentials. A bare scheme word needs a value that looks like one,
  // so that "Basic authentication" stays prose.
  [/\b((?:Proxy-)?Authorization\s*:\s*)((?:Bearer|Basic|Token|Digest|Negotiate)\s+)?[^\s"']+/gi, `$1$2${REDACTED}`],
  [/\b((?:Bearer|Basic|Token)\s+)(?:(?=[A-Za-z._~+/=-]*[0-9=+/])[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{16,})/g, `$1${REDACTED}`],
  [/\b((?:Set-)?Cookie\s*:\s*)[^\n"']+/gi, `$1${REDACTED}`],
  // The password in a URL, user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+):[^\s/?#@]+@/gi, `$1:${REDACTED}@`],
  // SQL.
  [/\b(IDENTIFIED\s+(?:WITH\s+\S+\s+)?BY\s+(?:PASSWORD\s+)?)(?:'[^'\n]*'|"[^"\n]*"|[^\s;,)]+)/gi, `$1${REDACTED}`],
  [/\b(PASSWORD\s*\(\s*)(?:'[^'\n]*'|"[^"\n]*")/gi, `$1'${REDACTED}'`],
  // Command lines: --password x, sshpass -p x, redis-cli -a x, curl -u user:x, mysql -px.
  [/(\s--?(?:passw(?:or)?d|pass|pwd)(?:\s+|=))(?:'[^'\n]*'|"[^"\n]*"|[^\s'"]+)/gi, `$1${REDACTED}`],
  [/\b(sshpass\s+-p\s*)(?:'[^'\n]*'|"[^"\n]*"|\S+)/g, `$1${REDACTED}`],
  [/\b(redis-cli\b[^\n]*?\s-a\s+)(?:'[^'\n]*'|"[^"\n]*"|\S+)/g, `$1${REDACTED}`],
  [/(\s(?:-u|--user)\s+[^\s:'"]+:)(?:'[^'\n]*'|"[^"\n]*"|[^\s'"]+)/g, `$1${REDACTED}`],
  [/\b(mysql(?:dump|admin)?\b[^\n]*?\s-p)(?=[^\s-])(?:'[^'\n]*'|"[^"\n]*"|\S+)/g, `$1${REDACTED}`],
  // Connection strings and signed URLs.
  [/\b(AccountKey|SharedAccessKey|SharedAccessSignature|sig)=[^;&\s"']+/gi, `$1=${REDACTED}`],
  // name = value, name: value, "name": "value", for a name that says secret.
  [new RegExp(`((?:^|[^A-Za-z0-9])${SECRET_NAME}["']?\\s*[:=]\\s*)${VALUE}`, 'gim'), `$1${REDACTED}`],
  // "the password is hunter2".
  [/\b(passw(?:or)?d|passphrase)(\s+(?:is|was)\s+)(?:'[^'\n]*'|"[^"\n]*"|[^\s,;.]+)/gi, `$1$2${REDACTED}`],
];

/** `text` with every secret a rule recognises replaced by [redacted]. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of RULES) redacted = redacted.replace(pattern, replacement);
  return redacted;
}
