# ECHO Sync — User Guide (English)

*Version 1.3.0 · Sync is optional and ships dark behind its feature flag.*

## What sync is (and is not)

ECHO is **local-first**: your library lives in your browser's IndexedDB and
the app is fully functional with no account, no cloud, and no network. Cloud
sync is an *optional* convenience that copies your library to your private
ECHO cloud space so your other devices can see it.

- **Accounts are username + password only.** There is no email address, no
  phone number, no Google/GitHub/social sign-in, and no magic link.
- **There is no password recovery.** If you forget your password, ECHO
  cannot restore access to the cloud account or its synced data. Save the
  username and password in a password manager (or a private, protected
  note) **before** creating the account — the app asks you to confirm you
  did.
- **Anonymous/local use is a complete mode**, not a demo.
- You can export/import your full library at any time without an account.

## What syncs and what never does

| Data | Syncs? |
|---|---|
| Your ratings, statuses, favourites, notes, tags | **Yes** — your own data |
| Identity fields of titles you added (title, year, type, provider id) | **Yes** |
| Engine inputs (genres, creators) for providers whose terms permit server storage | **Yes** |
| Artwork (posters, backdrops, trailers) | **Never** — no columns exist for it |
| Synopses | **No** (re-fetched on each device) |
| AniList-sourced records | **Never** — see below |
| Search history, pools, caches | **Never** |

### The AniList limitation (honest and by design)

AniList's terms prohibit using their API as a backup/storage service. Until
written clarification says otherwise, **AniList-sourced records stay on the
device that added them** — including your notes and ratings attached to
them. They carry a "stays on this device" badge. On another device they
simply do not appear. Everything else syncs normally. Export files still
contain them (your own device-portability artifact); their permissibility is
an open question we do not claim is settled.

## Turning sync on

1. Settings → **Account & sync** → **Create account** (or **Sign in** on a
   device that already has one).
2. Choose a username (3–32 characters: letters, numbers, underscores;
   capitalization does not matter) and a password (8–128 characters). The
   app shows the no-recovery warning and asks you to acknowledge it before
   the account is created.
3. Your device registers (a name like "Linux device" — rename it any time).

You can also **start sync without an account** (a temporary cloud session)
and convert it to a permanent username + password account later — the
conversion keeps everything, including the same account id.

## First sync on a device with existing data — the three choices

Before **anything** is written to the server, you choose:

- **Merge both (default).** Nothing is wiped. Records that differ between
  this device and the cloud become **conflict cards** you resolve one tap
  at a time. No side is ever silently overwritten.
- **Keep this device's data.** The cloud is replaced by this device's
  library. The previous cloud state is archived for **14 days** and can be
  restored.
- **Replace this device's data.** This device is wiped (after an automatic
  local safety copy of the discarded data and pending changes) and reloaded
  from the cloud. Nothing is pushed.

All three choices are behind a typed confirmation; both destructive paths
produce a backup first.

## Conflicts

When two devices edit the same record offline, the server keeps the state
that arrived first and archives the other — you get a **conflict card**
(both versions visible) with *Keep my version* / *Keep the other version*
choices. Restoring an archived edit is itself a normal synchronized
change. Conflicts you have not resolved are **never deleted automatically**.
If you ignore more than 200 of them, conflict-generating sync pauses (your
queued changes are kept, never discarded) until you resolve some — the app
says exactly that, in plain language.

## Deleted items

A confirmed delete is recoverable for **14 days** from the conflict viewer.
After that it is final. Devices that have not yet synced keep their local
copy until they pull; any export file you made also retains it.

## Changing your password

Settings → Account & sync → **Change password**. You must enter your
current password (this re-authenticates the session — it is not recovery).
If you forget the current password, the cloud account cannot be recovered.

## Devices & sign-out

Settings → Account & sync → **Devices** lists every device with its
last-sync time. You can rename or revoke any device. Revoking a lost device
immediately blocks its future pushes. Signing out disconnects this device
and **keeps all local data** — sign back in to resume.

## When the service is down

Nothing breaks. The app shows a passive "sync temporarily unavailable"
status and keeps working fully offline; your changes queue in the outbox
and drain when the service returns. Queued changes are only ever removed
after the server confirms them, one by one.

## Account deletion

Settings → Danger zone → type-to-confirm → re-authenticate. All cloud data
is deleted (cascades to every table). Your local data is kept unless you opt
into wiping it.
