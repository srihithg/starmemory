import type { StoreHandle } from './store.js';
/** The umask every entry point that writes sets: owner-only from the start. */
export declare const OWNER_ONLY_UMASK = 63;
export declare const OWNER_ONLY_DIR = 448;
export declare const OWNER_ONLY_FILE = 384;
/** Meta key set once tightenOnce has gone over the store's files. */
export declare const OWNER_ONLY_KEY = "owner_only_files";
/** Owner-only modes on `target` and, when it is a folder, everything under
 * it. Links are left as they are and never followed, and anything but plain
 * files and folders is left alone. A target that is missing is fine. */
export declare function tightenTree(target: string): void;
/** tightenTree over every one of `targets`, once per store: the meta key says
 * it was done, and new files are owner-only from the umask anyway. True when
 * it ran. */
export declare function tightenOnce(store: StoreHandle, targets: (string | undefined)[]): boolean;
