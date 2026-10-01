// Owner-only files. What starmemory keeps is the user's conversations, whole
// transcripts among them, and Claude Code keeps its own transcripts 0600 in
// 0700 folders. So every entry point that writes sets umask 077, every folder
// is made 0700, and tightenOnce takes group and other permissions off what an
// earlier version left readable to other accounts on the machine.
import fs from 'node:fs';
import path from 'node:path';
/** The umask every entry point that writes sets: owner-only from the start. */
export const OWNER_ONLY_UMASK = 0o077;
export const OWNER_ONLY_DIR = 0o700;
export const OWNER_ONLY_FILE = 0o600;
/** Meta key set once tightenOnce has gone over the store's files. */
export const OWNER_ONLY_KEY = 'owner_only_files';
/** Opened without following a link, and without waiting on a FIFO, so what is
 * changed is the file that was looked at. Absent where the platform has no
 * such flags, which is also where modes mean nothing. */
const NO_FOLLOW = fs.constants.O_NOFOLLOW === undefined ? undefined : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0);
/** Take group and other permissions off one file or folder, judged by `seen`,
 * its lstat. Only through a descriptor opened on that very file, so a link
 * put in its place since is never followed. */
function restrict(file, seen) {
    if (NO_FOLLOW === undefined || (seen.mode & 0o077) === 0)
        return;
    let fd;
    try {
        fd = fs.openSync(file, NO_FOLLOW);
    }
    catch {
        return; // gone, a link now, or unreadable: nothing of ours to change
    }
    try {
        const now = fs.fstatSync(fd);
        if (now.ino === seen.ino && now.dev === seen.dev)
            fs.fchmodSync(fd, now.mode & 0o7700);
    }
    catch {
        // another account's file, or a file system without modes
    }
    finally {
        fs.closeSync(fd);
    }
}
/** Owner-only modes on `target` and, when it is a folder, everything under
 * it. Links are left as they are and never followed, and anything but plain
 * files and folders is left alone. A target that is missing is fine. */
export function tightenTree(target) {
    let seen;
    try {
        seen = fs.lstatSync(target);
    }
    catch {
        return;
    }
    if (seen.isFile()) {
        restrict(target, seen);
        return;
    }
    if (!seen.isDirectory())
        return;
    restrict(target, seen);
    let entries;
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory() || entry.isFile())
            tightenTree(path.join(target, entry.name));
    }
}
/** tightenTree over every one of `targets`, once per store: the meta key says
 * it was done, and new files are owner-only from the umask anyway. True when
 * it ran. */
export function tightenOnce(store, targets) {
    if (process.platform === 'win32' || store.meta.get(OWNER_ONLY_KEY) === 1)
        return false;
    for (const target of targets)
        if (target)
            tightenTree(target);
    store.meta.putSync(OWNER_ONLY_KEY, 1);
    return true;
}
