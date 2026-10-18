// Enable the git pre-commit guard (.githooks/). Cross-platform; never fails the install
// (no git installed, or not a git repo yet -> just print a hint).
import { execFileSync } from 'node:child_process';
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('git pre-commit guard enabled (.githooks/)');
} catch {
  console.log('note: not a git repo yet — run "git init" then "npm run prepare" to enable the pre-commit guard');
}
