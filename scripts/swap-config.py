"""Atomarer macOS-Dateitausch mit Erhalt des tatsächlich abgelösten Inodes."""
import ctypes
import fcntl
import hashlib
import os
import stat
import sys

lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
swap = lib.renamex_np
swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
metadata = lib.fcopyfile
metadata.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]


def checked(status):
    if status != 0:
        raise OSError(ctypes.get_errno(), "Dateioperation fehlgeschlagen")


def digest(file):
    with open(file, "rb") as contents:
        return hashlib.sha256(contents.read()).hexdigest()


def exchange(a, b):
    checked(swap(os.fsencode(a), os.fsencode(b), 2))  # RENAME_SWAP


def verify_source(file, backup_parent):
    info = os.lstat(file)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            info.st_nlink != 1 or info.st_dev != os.stat(backup_parent).st_dev or
            info.st_flags & (stat.UF_IMMUTABLE | stat.SF_IMMUTABLE | stat.UF_APPEND | stat.SF_APPEND)):
        raise ValueError("Nicht unterstützter Eigentümer, Dateityp, Schutz oder Datenträger")


def main():
    if sys.argv[1] == "recovery-lock":
        with open(sys.argv[2], "rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print("ready", flush=True)
            sys.stdin.buffer.read(1)
        return 0
    action, file, backup_path = sys.argv[1:4]
    if action == "check":
        verify_source(file, backup_path)
        return 0
    expected = sys.argv[4]
    verify_source(file, os.path.dirname(backup_path))
    if os.path.lexists(backup_path):
        raise FileExistsError("Ablage belegt")
    if digest(file) != expected:
        return 75
    # Der private Sicherungsordner liegt auf demselben Volume. Beim Tausch bleiben
    # auch das abgelöste Original, seine ACLs und Änderungen über offene FDs erhalten.
    keep = False
    try:
        with open(file, "rb") as old, open(backup_path, "xb") as new:
            os.chmod(backup_path, 0o600)
            new.write(sys.stdin.buffer.read())
            new.flush()
            checked(metadata(old.fileno(), new.fileno(), None, 7))  # COPYFILE_METADATA
            os.fsync(new.fileno())
            src, dest = os.fstat(old.fileno()), os.fstat(new.fileno())
            if (src.st_uid, src.st_gid, src.st_mode) != (dest.st_uid, dest.st_gid, dest.st_mode):
                raise ValueError("Dateirechte konnten nicht identisch übernommen werden")
        intended = digest(backup_path)
        exchange(backup_path, file)
        keep = True
        displaced = os.lstat(backup_path)
        if displaced.st_ino == src.st_ino and displaced.st_mode == src.st_mode and digest(backup_path) == expected:
            return 0
        # Ein anderer Schreiber hat unmittelbar vor uns veröffentlicht. Immer beide
        # Inodes aufbewahren. Wenn wir noch aktuell sind, direkt zurücktauschen.
        if digest(file) == intended:
            exchange(backup_path, file)
            if digest(backup_path) == intended:
                return 75
        return 76
    finally:
        if not keep and os.path.lexists(backup_path):
            os.unlink(backup_path)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print("Sicherer Konfigurationstausch fehlgeschlagen:", type(error).__name__, file=sys.stderr)
        sys.exit(1)
