# Today

`/today` is what you open when you start your day. It is one chat: it opens with a short brief of what was done since yesterday, and then you talk to it. Ask it to accept or decline memories, to decide a project's memories from now on, or to report something in every Today, and it does that from then on.

```
Today · Sat 21 Nov

  shop      3 sessions: coupon route finished; the login test still fails on CI
  site      1 session: landing copy rewritten, not pushed
  Waiting   shop "Run the migration" waits for your approval
  Memory    151 pending in 3 groups: shop · conventions 120, user · preferences 30, shop · stack 1
  Checks    status.example.test answered 200 in 0.3 s; the dashboard's newest row is from 08:55

> accept the shop conventions, and from now on always accept that project's memories
```

## What the brief has

| Part | What it says | Read from |
|---|---|---|
| Done | per project, the sessions that ran since yesterday 00:00 and how each ended; when nothing ran yesterday, the last day anything ran in the past week | every folder's root sessions, each with its saved summary or, without one, the start of its last answer |
| Waiting | sessions with an approval or a question open, and sessions whose last turn failed or was interrupted | the sessions' state |
| Memory | pending memory proposals as groups by project and kind, with counts; never one line per memory unless you ask | every project's pending proposals |
| Standing requests | what you asked Today to do every time, carried out when the brief is written | Today's own file |

The brief is written by the chat's model, which is the default model of any new session (your `main` model role), never the `small` role. You can change the model in that chat as in any other.

There is one Today chat per day. The first `/today` of the day makes it, titled `Today · <day>`, in the folder your terminal is in; later `/today` commands that day reopen it without writing a second brief (ask "brief me again" in it when you want a fresh one). Earlier days' Today chats stay in `/sessions` as ordinary sessions you can read; the 14 newest still answer as Today.

## Talking to it

| You say | What Today does |
|---|---|
| "accept the shop conventions", "accept this whole group" | saves the pending memories of that project and kind |
| "decline the memories about the old deploy script" | reads the pending memories that mention it and declines those |
| "from now on always accept this project's memories" | saves a rule: that project's proposals are saved without waiting, and the ones waiting now are accepted |
| "never keep preference memories from the site project" | saves a rule: those proposals are not kept, and the ones waiting now are declined |
| "go back to asking me about shop" | removes the rule |
| "in every today, tell me how the billing project ended up" | saves a standing instruction that every following Today carries out |
| "check that my VPS and the dashboards are up and receiving data" | saves a standing instruction; each Today runs the check and reports what it saw |
| "stop checking the VPS" | removes that instruction |

Accepting a pending memory saves it; accepting a proposed change to a saved memory (Dream's updates and archives) applies the change. Declining archives a new proposal and drops a proposed change. A drafted action of the Memory assistant is not decided here: `/memory` reviews those.

### Memory rules

A rule names a project, a kind of memory (`commands`, `conventions`, `preferences`, `architecture`, `stack`, `release`, `constraints`, `security`, `objective`, `other`, `volatile`), or both, and says accept or decline. The most specific rule decides a proposal: project and kind, then project, then kind. A project is the folder a memory was proposed in, so a rule for a project also decides the user-wide memories proposed while working there.

With an accept rule, a proposal is saved when it is made instead of waiting in Pending, so the pile does not grow. Two things still wait for you: a proposal whose text had a secret redacted, and one from Evolution in suggest mode. The limits on how many memories a project and a profile keep apply as before, and a kind whose [policy](memory.md) is `never` is still dropped. A rule set here does not change the kind's policy in `/memory`; it is applied on top of it.

### Standing instructions

A standing instruction is one request in your words. Every Today lists them to its model, which carries each one out when it writes the brief, with the tools and the [permission mode](permissions.md) of that chat: a check of a server runs as a command or a web request you can see in the transcript, and asks for your approval when your mode asks for commands. The answer says what was run and what came back. When a check could not run or was refused, Today says so; it does not report a result it did not observe.

An instruction that carries a credential is refused: say where the secret is kept instead ([secrets](secrets.md)).

## The first Todays

While you have saved nothing, the brief ends with a short question: how do you want your Today? It proposes a shape built from what you really did in the last week (your most active projects, the agents you used, your scheduled loops, how many memories wait). Your answer is saved as standing instructions; "keep it like that" saves the proposal as it is. After that Today stops asking.

## What is stored and where

Today keeps one file, `today.json`, in MendCode's data directory, written only by Today: your standing instructions (at most 30), your memory rules (at most 60), whether the first question was answered, and which session is each day's Today chat (the newest 14). The chat itself is an ordinary session.

## Permissions and remote terminals

Reading the brief and saving or removing a standing instruction ask nothing. Accepting or declining memories and setting a rule are writes: they follow the chat's permission mode like any other write.

Today is local only, as memory is: over `--connect` the command answers that it is not available.

## Cost

Nothing of Today loads when MendCode starts: the terminal's part loads with the first `/today`, the daemon's with the first `/today` or the first turn of a Today chat. Nothing runs between visits and no timer is kept. The first `/today` of a day is one turn of your main model; reopening the chat calls no model. The daemon reads `today.json` once, the first time a memory is proposed or a turn starts.

## What replaced the old page

`/today` used to be a page with three tabs (Attention, Pick up, Memory), pins, dismissed rows and a triage key. Those are gone: the brief says the same in one screen and the chat does what the keys did. `/sessions`, `/reviews`, `/workflows` and `/memory` still list everything one by one. The terminal profile keys `todayLastVisit`, `todayMarks` and `todayDismissed` are no longer used and are kept only so old profile files read without a warning.
