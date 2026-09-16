# Keeping the data

Four layers, from the one that catches a slip to the one that catches a fire.
They are independent on purpose: each covers what the one before it cannot.

## 1 — Undo, in the table

`Ctrl+Z` in Device Selection, five steps, `Ctrl+Y` forward. Catches the
import that replaced too much and the delete that was one row too many,
in the second after it happened. Lives in the browser and goes when the
page is reloaded — it is for the last minute, not the last day.

## 2 — Version history, on the server

**File → History & restore…**

Before a project is overwritten, the version being replaced is kept in the
database beside it: sixty versions, spaced at least two minutes apart, so
they reach back over two hours of real work. Compressed, because JSON
compresses ten to twenty times and sixty copies of a five-megabyte project
would otherwise be three hundred megabytes.

Two ways back:

- **Restore this one** — one switchgear, as an older version had it. Nothing
  else in the project is touched. This is the one that is usually wanted.
- **Restore all** — the whole project, for when what went is its shape:
  templates, the device library, several switchgears at once.

Either way the project as it is now is written to a `.json` file first, so
choosing the wrong version is not the thing that loses the afternoon.

Nothing here can fail a save. If the history cannot be written the save still
goes through and the failure is logged — a safety net that catches the
tightrope walker on the way up is not one.

## 3 — A copy in a folder

**File → Save a copy to disk…** writes the whole project as `.json`.
**File → Restore from a copy…** reads one back.

This is the copy that does not depend on the database being well, the browser
keeping its cache, or the machine still existing. Worth taking at the end of a
day's real work and putting on a drive that is not that computer.

It is also what the application offers by itself the moment a save fails —
see below.

## 4 — A dump of the database, nightly

`simorgh-soft-mongo-backup` in `compose/soft-mongo.yml` runs `mongodump`
every night and keeps thirty days. The history in layer 2 lives *inside* the
database it protects, so it cannot be the answer to the database being lost;
this is.

The dumps land on a bind mount — the host filesystem, not a named volume —
because a backup only a `docker` command can reach is one nobody takes. Copy
them somewhere else regularly: a dump on the same disk as the database is one
disk failure from being no backup at all.

`mongodump --uri --archive` with no `--db` takes **every** database on the
server, which is why the office library (`simorgh_library` — the symbols added
in Simorgh Draw) is in these dumps too without anything being added here. It is
a separate database because it belongs to the office rather than to any job,
not because it is looked after separately.

## 5 — The library as a file

The office library has its own export, in Simorgh Draw's symbol panel:
**Export library** writes every symbol to one JSON file, **Import library**
reads one back — either merged into what is there, or replacing it outright.

This is not a duplicate of layer 4. A dump restores a server; a library file
moves between servers, is kept with the drawing set for a customer, or is the
copy somebody takes before reorganising the shelves. It is also the only
transport these sites have: the servers are off the internet.

```bash
# Where they are, by default
ls -lh ./backups/simorgh-soft-mongo/

# Change any of this in .env
SOFT_BACKUP_DIR=/srv/backups/simorgh-soft     # where dumps are written
SOFT_BACKUP_AT=02:30                          # HH:MM, the server's clock
SOFT_BACKUP_KEEP_DAYS=30

# Watch it work
docker logs -f simorgh-soft-mongo-backup

# Take one right now, without waiting for tonight
docker exec simorgh-soft-mongo-backup backup.sh once
```

The database and the backup sidecar are the same image —
`simorgh-soft-mongo`, which is `mongo:7` with `backup.sh` inside it. It is
built and published beside the application rather than pulled from Docker Hub,
so both come from one registry: on a server whose link to the outside is
unreliable, the image that has to come from somewhere else is the one that
fails on the day the link is bad, and it is the database.

### Putting a dump back

Into a spare database first, always — restoring over a live one is how a
bad day becomes a worse one.

```bash
# 1. Read it into a database beside the real one
docker exec -i simorgh-soft-mongo mongorestore \
  --uri=mongodb://localhost:27017 --gzip --archive=/backups/<file>.archive.gz \
  --nsFrom='simorgh.*' --nsTo='simorgh_check.*'

# 2. Look at it
docker exec -it simorgh-soft-mongo mongosh \
  --eval 'db.getSiblingDB("simorgh_check").projects.find({}, {projectName:1, changedOn:1, rev:1}).toArray()'

# 3. Only then, over the real one
docker exec -i simorgh-soft-mongo mongorestore \
  --uri=mongodb://localhost:27017 --gzip --archive=/backups/<file>.archive.gz --drop
```

## What the application does on its own

- **Two computers cannot overwrite each other.** Every project carries a
  version; a save says which version it started from and only lands on a
  document still on it. A save built on a copy somebody else has changed is
  refused and the choice is put to the person, with the losing side written to
  a file either way.
- **Two projects cannot share a name.** A unique index on a normalised name,
  in the database rather than in the app, because a rule that is not the
  database's is one two clients can pass at once.
- **A save that does not land is not quiet.** The status bar says "Not saved"
  in red, a dialog says so in the only way that cannot be missed, autosave
  keeps trying every fifteen seconds, and closing the window asks first.

## Checking it is all actually working

Worth doing once, before the first real project, and once a month after.

| | What to do | What should happen |
|---|---|---|
| Undo | Delete a few rows, `Ctrl+Z` | They come back |
| History | File → History & restore… | Versions listed, oldest a couple of hours back |
| Per-switchgear | Restore one switchgear from a version | Only that one changes |
| Save failure | `docker stop simorgh-soft` backend, edit something | Red "Not saved", then the dialog |
| Recovery | Start it again | Saves by itself, status returns to "Last saved" |
| Nightly dump | `ls -lh ./backups/simorgh-soft-mongo/` | A file from last night, a few MB |
| Restore | Put last night's dump into `simorgh_check` | The projects are in it |
