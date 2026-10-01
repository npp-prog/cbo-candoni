# CFMS deployment — step by step for first-timers

Using **GitHub Desktop** (no git commands).

This is the same twelve phases as [`runbook.md`](runbook.md), rewritten assuming you have never
used GitHub, Firebase or a terminal before. Every click is named. Every command tells you what it
does, what you should see, and what to do if you see something else.

**Read this first:** you cannot avoid the terminal entirely. Firebase has no desktop app, so about
eight commands must be typed. GitHub Desktop gives you a button that opens the terminal already in
the right folder, so you will never have to work out where you are. That is step 1.4.

**Second thing to know:** if something goes wrong, it is very unlikely to be the code. In practice
almost every error in phases 1 and 3 comes from one of three ordinary Windows things — the project
folder ending up one level too deep, using the wrong one of two similar menus, or typing a
Command Prompt command into PowerShell. Each has a named fix below. Jump straight to it:

| What you are seeing | Go to |
|---|---|
| Commit failed, `nothing added to commit but untracked files present` | step 1.1, "Repair" |
| GitHub Desktop shows only **1** changed item, a folder | step 1.1, "Repair" |
| `npm error ENOENT ... \functions\package.json` | step 3.3 |
| `npm warn install-scripts ... not yet covered by allowScripts` | step 3.3 |
| `A positional parameter cannot be found` | the terminal note below |
| `127.0.0.1 refused to connect` at step 3.7 or 3.8 | step 3.6, "If `npm run emulators` does not reach..." |
| Approve / Certify / Post fails with just **`internal`** | step 3.6, "If the engine does not load" |
| Anything else | the table at the end, **When something goes wrong** |

Nothing in this list damages anything. Folders can be moved and repositories re-created as often as
you like — the code in them is unaffected.

---

## Some words you will see

| Word | What it actually means |
|---|---|
| **Repository** (repo) | A folder whose history is tracked. Your CFMS code lives in one. |
| **Commit** | A save point with a note attached. Like "Save As" with a description. |
| **Push** | Upload your commits to GitHub. GitHub Desktop's button says "Push origin". |
| **Branch** | A parallel copy of the code. `main` is the real one; `develop` is for testing. |
| **Terminal** | A black window where you type commands. Windows has two — see the note below. |
| **Firebase** | Google's service holding the database, logins and files. |
| **Netlify** | The service that serves the website at your address. |
| **Deploy** | Upload code so it becomes live. |
| **CLI** | Command Line Interface — a tool you run by typing, not clicking. |

> **Windows has two terminals, and it matters.** **Command Prompt** (first line reads
> `Microsoft Windows [Version ...]`) and **PowerShell** (first line reads `Windows PowerShell`, and
> every prompt begins with `PS `). Almost everything in this guide — `npm`, `firebase`, `node`,
> `dir` on its own — works identically in both. Only a handful of Windows commands with `/`
> switches, like `dir /s /b`, are Command Prompt only; where one appears, a PowerShell version is
> given beside it. If a command fails with *"A positional parameter cannot be found"*, you are in
> PowerShell and gave it a Command Prompt command. To open Command Prompt: press the Windows key,
> type `cmd`, press Enter.

---

# PHASE 0 — Install what you need

### 0.1 Install Node.js (version 22)

Node.js runs the build tools.

**It must be version 22.** Not newer. Cloud Functions runs your accounting engine on Node 22, so
that is what this project is built and tested against. A newer Node on your computer does not fail
loudly - the emulator prints a small warning, the engine silently refuses to load, and every
approval, certification and posting then comes back as an unhelpful **"internal"** error while the
rest of the system looks perfectly healthy.

1. Go to **https://nodejs.org**
2. If the big green button does not say **22.x**, click **"Previous Releases"** (or
   **Download Archive**) and choose the newest **22.x.x**.
3. On that version's page, scroll past the `.zip` rows in **Binary Downloads** to the row named
   **`node-v22.x.x-x64.msi`** - the one whose OS column says Windows and whose name ends in
   **`.msi`**, not `.zip`. A `.zip` does not install anything; the `.msi` is the installer.
4. Run it. Accept every default. Click Next until Finish.
5. **Restart your computer.** Skipping this is the most common cause of "node is not recognised".
6. Check with `node --version`. It must start with **v22**. If it shows a different version, an
   older or newer Node is still ahead of it - uninstall that one under
   **Add or remove programs**, then check again.

### 0.2 Install Java

You will not write a line of Java. But the Firestore and Storage emulators — the offline copies of
the database you test against in phase 3 — are Java programs. Without Java they refuse to start,
and the symptom appears much later as *"127.0.0.1 refused to connect"*, which looks like a network
problem and is not.

**It must be version 21 or higher, and it must be a JDK, not a JRE.** Firebase refuses anything
older with the message *"firebase-tools no longer supports Java version before 21"*. Many office
computers already carry Java 8 from years ago; that one does not count, and worse, it can hide the
new one — see the warning below.

1. Go to **https://adoptium.net**
2. In the version dropdown choose the newest **LTS**, and choose **JDK** (not JRE). On Windows take
   the `.msi` installer.
3. Run it. On the **Custom Setup** page, make sure these two are switched on — if either shows a red
   X, click it and choose *"Will be installed on local hard drive"*:
   - **Set JAVA_HOME variable**
   - **Add to PATH**
4. Restart the computer (you can do this together with the restart in 0.1).

To check it worked, open a **new** terminal and type:

```
java -version
```

**You should see:** `openjdk version "21..."` or higher, and the word `Temurin`.

> **If it still shows an old version such as `1.8.0_351`,** an older Java is ahead of the new one.
> Two things to try, in order:
>
> 1. **Close every terminal, and fully quit GitHub Desktop** (close the window; do not just
>    minimise). Windows hands each program its list of installed tools when the program starts, so
>    anything that was already open is still working from the list as it was *before* you installed
>    Java. Terminals opened from GitHub Desktop inherit that stale list. Reopen and check again.
> 2. Still old? Remove the old one: Windows key → **Add or remove programs** → search `Java` →
>    uninstall **Java 8 Update ...**. Leave the Temurin entry alone. Then check again.

### 0.3 Install GitHub Desktop

1. Go to **https://desktop.github.com**
2. Download and install.
3. Open it. It asks you to sign in to GitHub — if you have no account, click **"Create your free
   account"**, make one, then come back and sign in.
4. It asks for your name and email for commits. Use your work email.

### 0.4 Check they all worked

Open a terminal:

- **Windows:** press the Windows key, type `cmd`, press Enter.
- **Mac:** press Cmd+Space, type `terminal`, press Enter.

Type this and press Enter:

```
node --version
```

**You should see:** `v22.11.0` or similar — the important part is that it starts with **`v22`**.

Then:

```
npm --version
```

**You should see:** `10.2.4` or similar. Any 10.x is fine.

Then:

```
java -version
```

**You should see:** `openjdk version "21..."` or higher. This one is easy to skip because nothing
needs it until phase 3 — but when it is missing or too old, phase 3 fails.

> **If you see "not recognised as an internal or external command":** that tool did not install
> properly, or you did not restart. Restart, and try again. If it still fails, reinstall it.

### 0.5 Things only the municipality can decide

Get written answers before phase 10. They cannot be changed easily later:

1. **Which fiscal year does CFMS start recording?** (e.g. 2026)
2. **Who is the first Super Administrator?** One named person with their own email. Not a shared
   account like `accounting@`.
3. **Which funds at go-live?** General Fund only is the sensible first step.
4. **Are the tax rates current?** The system is seeded with TRAIN-era BIR withholding rates. The
   Accountant must confirm them against the current BIR issuance — a wrong rate leaves the
   municipality owing the difference.

### 0.6 A credit card for Firebase

Cloud Functions need Firebase's **Blaze** (pay-as-you-go) plan, which requires a card on file. For
Candoni's volume expect a few US dollars a month; the free tier covers most of it. You will set a
budget alert in phase 2 so it cannot surprise you.

**Checkpoint 0:** `node --version` shows v22.x, `java -version` shows a version, GitHub Desktop is
signed in, and you have the four answers written down.

---

# PHASE 1 — Put the code on GitHub

> ### Read this before you unzip anything
>
> Almost every problem people hit in this phase is the same problem wearing different clothes:
> **the folder ends up one level too deep.** The zip contains a folder called `cbo-candoni`, and
> several ordinary Windows actions quietly wrap it in *another* folder of the same name.
>
> The rule that prevents all of it: **the project folder is the one that contains `package.json`.**
> Not a folder containing that folder. That one, exactly.
>
> Take the extra two minutes in 1.1. It is much faster than undoing it later.

### 1.1 Unzip the code

**Step 1 — clear the way first.**

Open File Explorer and look in `Downloads`, `Documents`, and `Documents\GitHub`. If a folder named
`cbo-candoni` already exists in any of them, **delete it now** (or rename it to `cbo-old` if you
want to keep it).

This matters more than it sounds. If a folder of that name already exists, Windows does not replace
it — it drops the new one *inside* the old one, and you get `cbo-candoni\cbo-candoni` without any
warning. That single behaviour causes most of the trouble in this phase.

**Step 2 — do not use "Extract All".**

"Extract All" adds a wrapper folder of its own. Use this instead:

1. **Double-click** `cbo-candoni.zip` in Downloads. It opens like a normal folder.
2. Inside you see **one folder**, `cbo-candoni`.
3. **Drag that folder** into `Documents`.
4. Wait for the copy to finish.

You should now have `C:\Users\<you>\Documents\cbo-candoni`.

> **Mac:** double-click the zip, then drag the resulting `cbo-candoni` folder into Documents.

**Step 3 — verify before going further. Do not skip this.**

Open `Documents\cbo-candoni` and check the contents against this list:

| You should see | Meaning |
|---|---|
| `package.json` | ✅ You are in the right folder. Continue. |
| another folder called `cbo-candoni`, and no `package.json` | ❌ One level too deep — see the repair below |

The right folder contains roughly 20 items, including `src`, `functions`, `docs`, `scripts`,
`public`, `package.json`, `firebase.json`, `README.md` and `netlify.toml`, all side by side.

**Repair, if you got the nested version.** This happens to almost everyone once; it takes a minute
to fix.

1. Rename the outer `cbo-candoni` to `cbo-temp` (right-click → Rename). This removes the name clash
   that caused the problem.
2. Open `cbo-temp` and find the folder or level that has `package.json` in it.
3. Drag **that** folder out into `Documents`. Because nothing there is named `cbo-candoni` any more,
   it lands correctly.
4. If the folder you dragged out has a different name, rename it to `cbo-candoni`.
5. Delete `cbo-temp`.

> **Do not leave the project in Downloads**, and avoid OneDrive, Google Drive or Dropbox folders.
> Sync tools and some antivirus corrupt `node_modules`, producing errors that look like code
> problems but are not. Note that on many Windows 11 machines `Documents` is itself synced to
> OneDrive — if yours is, put the project at `C:\cbo-candoni` instead. Everything else in this guide
> works the same; just read `C:\cbo-candoni` wherever it says `Documents\cbo-candoni`.

### 1.2 Turn the folder into a repository

**Use File → Add local repository. Do not use File → New repository.**

They sound alike and do very different things. "New repository" *creates a new empty folder*, which
is how people end up with a repository wrapped around their project instead of on it.

1. Open **GitHub Desktop**.
2. Menu **File → Add local repository…**
3. Click **Choose…**, select `Documents\cbo-candoni`, click **Select Folder**.
4. GitHub Desktop says: *"This directory does not appear to be a Git repository. Would you like to
   create a repository here instead?"* → click the blue **create a repository** link.
5. A form appears. Check the **Local path** line reads `...\Documents` and the **Name** reads
   `cbo-candoni` — together they must point at the folder you just verified, with the name appearing
   only once.
   - **Name:** `cbo-candoni`
   - **Description:** `Candoni Financial Management System — Municipal Financial Management System`
   - **Git ignore:** leave as **None** (the code already includes the right one)
   - **License:** None
6. Click **Create Repository**.

**Now read the "Changes" list on the left. It tells you immediately whether this worked.**

| Changes shows | Verdict |
|---|---|
| **around 170 files** | ✅ Correct. Continue to 1.3. |
| **1 item, and it is a folder named `cbo-candoni`** | ❌ The repository sits one level too high. Go back to 1.1 and use the repair. |
| **tens of thousands of files** | ❌ `node_modules` is being tracked. Check a file named `.gitignore` exists in the folder. |

> If you continue past a "1 item" result, committing fails with
> *"nothing added to commit but untracked files present"*. That message is not a broken
> installation — it is git telling you the repository is around the project rather than on it.
> Fix the folder; the message disappears.

### 1.3 Make your first commit and publish

1. Bottom-left, in the **Summary** box, type: `CFMS initial system`
2. Click **Commit to main**.
3. Top of the window, click **Publish repository**.
4. **IMPORTANT — the dialog has a tick box "Keep this code private". MAKE SURE IT IS TICKED.**
   This is a government financial system. It must not be public.
5. Click **Publish repository**.

Wait for the upload. When the top bar stops showing progress, your code is on GitHub.

### 1.4 The button that opens the terminal in the right place

**Learn this now — you will use it constantly.**

In GitHub Desktop, menu **Repository → Open in Command Prompt** (Windows) or
**Repository → Open in Terminal** (Mac).

A black window opens, already inside your `cbo-candoni` folder. Every command in this guide is
typed there.

> **Windows:** if it says Command Prompt is not installed, it means Git was not bundled. Go to
> GitHub Desktop → File → Options → Integrations → set Shell to **Command Prompt**.

### 1.5 Create the develop branch

`main` is the live code. `develop` is where you test first.

1. Top of GitHub Desktop, click **Current Branch: main**.
2. Click **New Branch**.
3. Name it exactly: `develop`
4. Click **Create Branch**, then **Publish branch**.

### 1.6 Protect main (do this on the GitHub website)

1. Go to **https://github.com** → your repositories → `cbo-candoni`.
2. **Settings** tab → **Branches** in the left menu.
3. **Add branch protection rule** (or "Add rule").
4. Branch name pattern: `main`
5. Tick **Require a pull request before merging**.
6. Tick **Require status checks to pass before merging**.
7. Click **Create**.

This stops a broken change reaching production.

**Checkpoint 1:** On github.com your repository shows the files, has a **Private** label next to
its name, and the **Actions** tab shows a run with a green tick. If Actions shows a red X, click
into it and read the error — but this normally passes.

---

# PHASE 2 — Create the Firebase development project

"Development" is your practice environment. Nothing here is real municipal data.

### 2.1 Create it

1. Go to **https://console.firebase.google.com**
2. Sign in with the **municipality's** Google account, not your personal one. This account owns
   the data.
3. Click **Create a project**.
4. Name: `cbo-candoni-dev` — Firebase may add random characters to make the ID unique. **Write the
   exact ID down**, you need it later.
5. **Turn OFF Google Analytics.** No benefit here, and it adds a data-sharing question you do not
   need.
6. Click **Create project**, wait, click **Continue**.

### 2.2 Upgrade to Blaze

1. Bottom-left corner, find the plan name (it says **Spark**). Click it.
2. Select **Blaze — Pay as you go** → **Continue**.
3. Add a payment method.
4. When offered, **set a budget alert of $50/month**. Do it — it is your safety net.

### 2.3 Turn on Authentication

1. Left menu → **Build → Authentication** → **Get started**.
2. Under "Sign-in providers" click **Email/Password**.
3. Turn on the **first** toggle (Email/Password). Leave "Email link" off.
4. **Save**.

### 2.4 Turn on Firestore

1. Left menu → **Build → Firestore Database** → **Create database**.
2. Choose **Start in production mode** → Next.
   *(This means "block everything by default". The code replaces those rules with real ones.)*
3. Location: **asia-southeast1 (Singapore)**.
   **This cannot be changed later.** Singapore is the closest region with full support.
4. **Enable**.

### 2.5 Turn on Storage

1. Left menu → **Build → Storage** → **Get started**.
2. **Start in production mode** → Next.
3. Location: it should already show `asia-southeast1`. **Done**.

### 2.6 Register the web app and copy the settings

1. Click the **gear icon** (top left, next to "Project Overview") → **Project settings**.
2. Scroll to **Your apps** → click the **`</>`** (web) icon.
3. App nickname: `CFMS Web`
4. **Do NOT tick "Also set up Firebase Hosting"** — we use Netlify.
5. **Register app**.
6. You now see a code block. Find these six lines and **copy them into Notepad**:

```
apiKey: "AIza..............."
authDomain: "cbo-candoni-dev.firebaseapp.com"
projectId: "cbo-candoni-dev"
storageBucket: "cbo-candoni-dev.appspot.com"
messagingSenderId: "123456789012"
appId: "1:123456789012:web:abc123..."
```

Label them clearly **DEV**. In phase 7 you will collect a second set labelled PROD, and mixing the
two is the most expensive mistake available at this stage.

7. Click **Continue to console**.

**Checkpoint 2:** Authentication, Firestore and Storage all show as set up, the plan says Blaze,
and you have six DEV values in Notepad.

---

# PHASE 3 — Install and test on your own computer

### 3.1 Install the Firebase tool

Open the terminal (GitHub Desktop → Repository → Open in Command Prompt) and type:

```
npm install -g firebase-tools
```

**You should see:** several lines, then `added NNN packages`. Takes 1–2 minutes.

> **Windows, if you get "EACCES" or permission errors:** close the terminal, search for "Command
> Prompt" in the Start menu, right-click → **Run as administrator**, and run the command again.

### 3.2 Log in to Firebase

```
firebase login
```

Your browser opens. Sign in with the **same municipality Google account**. Click **Allow**.

**You should see:** back in the terminal, `✔ Success! Logged in as ...@...`

### 3.3 Install the project's own tools

**First, confirm you are in the right folder.** Type this (it works in both Command Prompt and
PowerShell):

```
dir
```

**The list must include both `functions` and `package.json`.** If it does not, you are in the
wrong folder — go back to step 1.1 and find the real project root. Running `npm` from the wrong
place is the most common problem at this step, and npm makes it confusing by searching *parent*
folders for a `package.json`, so the first command may appear to work and the second then fails
with `ENOENT ... functions\package.json`.

> **If you moved or renamed the project folder after a previous `npm install`,** delete both
> `node_modules` folders first — one in the project root, one inside `functions` — and install
> again. Installed packages record where they were installed, and a moved folder leaves them
> pointing at an address that no longer exists.

Now:

```
npm install
```

**You should see:** a progress bar, then `added ~390 packages`. Takes 1–3 minutes.

Then:

```
npm --prefix functions install
```

**You should see:** `added ~500 packages`.

#### Warnings you can ignore

Yellow `npm warn deprecated` lines, and the `npm audit` summary mentioning vulnerabilities, are
normal. **Do not run `npm audit fix --force`** — it upgrades packages past what this project was
tested against and will break the build.

#### One warning you must NOT ignore

If you see this:

```
npm warn install-scripts 6 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
```

then a newer version of npm has **blocked the setup scripts**. esbuild is the tool that builds the
website, so if its script was blocked, `npm run verify` in step 3.5 will fail at the build with a
confusing error.

Check what you have:

```
node --version
npm --version
```

| What you see | What to do |
|---|---|
| node **v22.x**, npm **10.x** | Nothing. You will not see this warning. |
| node v23 or higher, npm **11.x or 12.x** | Fix it using one of the two options below |

**Option A — recommended.** Install **Node 22 LTS** from nodejs.org (Previous Releases → newest
22.x). It ships npm 10, which does not block install scripts, and it matches the Node version
Cloud Functions actually run — so you avoid a whole class of "works on my computer, fails when
deployed". After installing: restart the computer, **delete both `node_modules` folders** (one in
the project root, one inside `functions`), and run the two install commands again.

**Option B — quicker.** Approve the scripts, exactly as the warning suggests:

```
npm install-scripts approve esbuild
npm install-scripts approve @firebase/util
npm install-scripts approve protobufjs
npm install
```

> **"npm is not recognised":** Node.js is not installed properly. Go back to phase 0.
>
> **`ENOENT: no such file or directory, open '...\functions\package.json'`:** you are in the wrong
> folder. Run `dir` and check for `functions` and `package.json`.

### 3.4 Create your settings file

1. In File Explorer / Finder, open the `cbo-candoni` folder.
2. Find the file called **`.env.example`**.

   *Windows: if you cannot see it, open the folder, click the **View** tab, and tick **Hidden
   items**. Files starting with a dot are hidden by default.*
3. **Copy** it and **paste** it in the same folder. You get `.env - Copy.example` or similar.
4. **Rename** the copy to exactly: `.env.local`
   — including the leading dot, and with **no** `.txt` on the end.
5. Open `.env.local` in Notepad (right-click → Open with → Notepad).
6. Replace the whole contents with this, pasting your **DEV** values from Notepad:

```
VITE_FIREBASE_API_KEY=paste_your_dev_apiKey_here
VITE_FIREBASE_AUTH_DOMAIN=cbo-candoni-dev.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=cbo-candoni-dev
VITE_FIREBASE_STORAGE_BUCKET=cbo-candoni-dev.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=paste_your_sender_id_here
VITE_FIREBASE_APP_ID=paste_your_appId_here
VITE_FIREBASE_FUNCTIONS_REGION=asia-southeast1
VITE_USE_EMULATORS=true
VITE_ENVIRONMENT=development
```

7. **Save** and close.

> **No quotes, no spaces around the `=`.** `VITE_FIREBASE_PROJECT_ID=cbo-candoni-dev` is right;
> `VITE_FIREBASE_PROJECT_ID = "cbo-candoni-dev"` is wrong.

> This file is deliberately **not** uploaded to GitHub — check GitHub Desktop, it should not
> appear in the Changes list. That is correct and intended.

### 3.5 Check everything builds

```
npm run verify
```

This runs six checks in sequence: the security-rule checks, the type checker, 46 accounting tests,
a production build, the Cloud Functions build, and the Functions tests. Takes 2–4 minutes.

**You should see, in order:**

```
All security rule checks passed.
Test Files  1 passed (1)
     Tests  46 passed (46)
✓ built in 7.02s
Test Files  1 passed (1)
     Tests  4 passed (4)
```

> **If anything fails, stop here.** Copy the whole terminal output and ask for help. Do not
> continue — everything after this assumes the code builds.

### 3.6 Run it locally

You need **two terminal windows** open at the same time.

**Window 1** (the one you have):

```
npm run emulators
```

**You should see:** a table of emulators and `All emulators ready!`. **Leave this window open and
running.** Closing it stops everything.

> **This window is a running program, not a command that finishes.** The emulators exist only while
> it is open. If you close it, press Ctrl+C in it, restart the computer, or it shows an error and
> returns you to the prompt, then the database, the sign-in service and the control panel at
> `127.0.0.1:4000` all stop existing — and every later step in phase 3 fails with
> *"127.0.0.1 refused to connect"*. That message never means the code is broken. It means nothing
> is running on that port.

#### If the engine does not load

Watch Window 1 for this, a few seconds after the emulators start:

```
functions  Failed to load function definition from source: ...
           Cannot determine backend specification. Timeout after 10000.
```

This one is quiet and expensive. The emulators still say **All emulators ready!**, the website
still loads, master data still saves — but the accounting engine is not running. Every action that
goes through it (Approve, Certify, Post, Pay, Reconcile) then fails with a bare **`internal`**, and
nothing on screen explains why.

Two causes, in order of likelihood:

| Also in the log | Meaning | Fix |
|---|---|---|
| `Your requested "node" version "22" doesn't match your global version "24"` | Your Node is newer than the engine is built for | Install **Node 22** — step 0.1 |
| No such line | The engine has not been compiled since you last changed it | `npm run functions:build`, then restart the emulators |

After either fix, restart Window 1 and confirm the log now reads
`functions: Loaded functions definitions from source` with no `Failed` line above it. Do not
continue past this point until it does — everything in phases 4 onward depends on the engine.

#### If `npm run emulators` does not reach "All emulators ready!"

Read what Window 1 actually printed. The three common ones:

| What Window 1 says | What it means | Fix |
|---|---|---|
| `firebase-tools no longer supports Java version before 21` | Java is missing, or the one on this computer is too old | Install Temurin JDK 21+ — step 0.2 — then close all terminals **and** quit GitHub Desktop before trying again |
| Anything else mentioning **Java** or `JAVA_HOME` | Same cause | Step 0.2 |
| `Error: Cannot find module ... functions/lib` or a functions build error | The engine has not been compiled yet | Run `npm run functions:build`, then `npm run emulators` again |
| `Port 4000 is not open` / `address already in use` | An older emulator is still running in the background | Close every terminal window, then open one and try again. If it persists, restart the computer |

If Window 1 is showing `All emulators ready!` and `127.0.0.1:4000` still refuses, you are looking at
the wrong window — check you have not opened a second Window 1 that failed, and that the address is
`127.0.0.1:4000` exactly, not `localhost:4000` with a different port.

**Window 2** — open a second one (GitHub Desktop → Repository → Open in Command Prompt again):

```
npx tsx scripts/seed.ts --project cbo-candoni-dev --emulator
```

**You should see:** `funds: 3 records`, `accounts: ~100 records`, `offices: 18 records`, and so on.

Then, in the same Window 2:

```
npm run dev
```

**You should see:** `Local: http://localhost:5173/`

Open **http://localhost:5173** in your browser. You should see the CFMS sign-in page with the navy
panel on the left.

### 3.7 Create a test user

1. Open **http://127.0.0.1:4000** in another browser tab. This is the emulator control panel.
2. Click **Authentication** → **Add user**.
3. Email: `test@candoni.local`  Password: `Test1234!`
4. **Save**.
5. Go back to **http://localhost:5173** and sign in with those details.

**You should see:** a page saying **"Awaiting access"**.

**This is correct.** A new account has no role and can see nothing. That is the system working.

### 3.8 Make yourself the administrator

1. Back in the emulator panel (**127.0.0.1:4000** → Authentication), find your test user.
2. At the right of the row click the **three dots (⋮)** → **Edit user**.
3. Find **Custom Claims** and paste exactly:

```json
{ "roles": ["SUPER_ADMIN"], "officeScope": [], "fundScope": [], "active": true }
```

4. **Save**.
5. In the CFMS tab, sign out (click your name, top right → Sign out) and sign in again.

**You should now see the dashboard.**

### 3.9 THE TEST THAT MATTERS

This proves the money controls actually work. Do not skip it.

**Step A — create budget authority**
1. Left menu → **Budget → Appropriation** → **Record appropriation**.
2. Type: `Original`. Office: any (e.g. Office of the Municipal Mayor).
   Account: type `50203010`, pick *Office Supplies Expenses*.
   Amount: `1000000`
3. **Save draft**. In the list, click **Approve** → **Approve**.

**Step B — release less than that**
1. **Budget → Allotments** → **Release allotment**.
2. **Same office, same account.** Amount: `500000`
3. **Save draft** → **Release** → **Release**.

**Step C — try to spend more than was released**
1. **Budget → Obligations** → **New obligation**.
2. Payee: any. Requesting office: the same one. Particulars: `Test`.
3. In the line: same office, same account, Amount: `600000`
4. **Save draft** → **Certify**.

**A red message must appear**, saying something like:

> Insufficient allotment on line 1 (50203010 Office Supplies Expenses): 600,000.00 requested
> against 500,000.00 available, short by 100,000.00.

**If it refuses — the system is working.** Change the amount to `400000`, save, and certify again;
it should succeed and give you an OBR number like `100-26-09-0001`.

**If it lets the ₱600,000 through — STOP.** Something is wrong and nothing downstream can be
trusted. Get help before going further.

**Checkpoint 3:** The over-allotment attempt was refused, and the valid one produced an OBR number.

When finished, press **Ctrl+C** in both terminal windows to stop them.

---

# PHASE 4 — Put the backend on Firebase (development)

### 4.1 Point the tool at the dev project

```
firebase use --add
```

Use the **arrow keys** to highlight `cbo-candoni-dev`, press **Enter**.
It asks for an alias — type `dev`, press Enter.

### 4.2 Deploy

```
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
```

**The first time takes 5–10 minutes.** It will ask permission to enable "Cloud Build API" and
"Artifact Registry API" — type `y` and press Enter.

**You should see, at the end:** `✔ Deploy complete!`

> **"Your project must be on the Blaze plan":** go back to phase 2.2.
> **"Error: HTTP Error: 403":** wait two minutes and run it again — the APIs take a moment.

### 4.3 Wait for the indexes

1. Firebase console → **Firestore Database** → **Indexes** tab.
2. About 40 indexes are listed. Some will say **Building**.
3. **Wait until every one says Enabled.** Usually 5–15 minutes. Refresh the page to check.

Reports will fail with a confusing error until this finishes.

### 4.4 Load the reference data

```
npx tsx scripts/seed.ts --project cbo-candoni-dev
```

Note: **no** `--emulator` this time. This writes to the real dev database.

**Checkpoint 4:** Firebase console → Firestore → Data shows collections named `accounts`, `funds`,
`offices`, `taxCodes`, `numberingRules`, `settings`. Functions shows 19 functions, all in
`asia-southeast1`.

---

# PHASE 5 — Put the website on Netlify (staging)

### 5.1 Connect Netlify to GitHub

1. Go to **https://app.netlify.com** → sign up, choosing **Sign up with GitHub**.
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub**. Authorise it when asked.
4. It lists your repositories. If `cbo-candoni` is missing, click **Configure the Netlify app on
   GitHub** and grant access to it (it is private, so Netlify needs explicit permission).
5. Select **cbo-candoni**.

### 5.2 Build settings

| Field | Value |
|---|---|
| Branch to deploy | **develop** |
| Build command | `npm run build` |
| Publish directory | `dist` |

Click **Deploy site**. The first build **will fail** — that is expected, the settings come next.

### 5.3 Add the settings

1. **Site configuration → Environment variables → Add a variable → Add a single variable.**
2. For each row below: enter the Key, enter the Value, and under **Scopes** choose
   **Specific deploy contexts** → tick **Deploy previews** and **Branch deploys** (not Production
   yet). Click **Create variable**. Repeat.

| Key | Value |
|---|---|
| `VITE_FIREBASE_API_KEY` | your DEV apiKey |
| `VITE_FIREBASE_AUTH_DOMAIN` | `cbo-candoni-dev.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `cbo-candoni-dev` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `cbo-candoni-dev.appspot.com` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | your DEV sender id |
| `VITE_FIREBASE_APP_ID` | your DEV appId |
| `VITE_FIREBASE_FUNCTIONS_REGION` | `asia-southeast1` |
| `VITE_ENVIRONMENT` | `staging` |

### 5.4 Note your Netlify address, then rebuild

1. **Site configuration → Site details.** Your address looks like
   `https://fancy-name-123456.netlify.app`. **Write it down** — phase 8 needs it.
2. Optionally rename it: **Change site name** → `candoni-books-online`.
3. Go to **Deploys** → **Trigger deploy → Deploy site**.

### 5.5 Let Firebase accept that address

1. Firebase console (`cbo-candoni-dev`) → **Authentication → Settings → Authorised domains**.
2. **Add domain** → paste your Netlify address **without** `https://`
   (e.g. `candoni-books-online.netlify.app`).

### 5.6 Open it

Visit your Netlify address.

**You should see:** the sign-in page with an **amber "STAGING environment" bar** across the top.
That bar is how anyone can tell at a glance this is not the real books.

Sign in with your test user. If it says "Awaiting access", use the **Firebase console** (not the
emulator) → Authentication → your user → three dots → **Edit user** → Custom Claims → paste the
same JSON as step 3.8 → Save → sign out and in.

**Checkpoint 5:** Staging loads with the amber bar, you can sign in, and repeating the phase 3.9
over-allotment test still gets refused.

---

# PHASE 6 — Let the officers test it

Do this **before** production exists. Book 2–3 hours with the Municipal Accountant, the Budget
Officer and the Treasurer, in one room, on staging.

### 6.1 Create one user per role

For each person: Firebase console → Authentication → **Add user** → their email and a temporary
password. Then in CFMS: **Administration → Users and Roles** → find them → **Manage access** → tick
their role → **Save access**. They sign in and change nothing else.

### 6.2 Walk the list

Work through the 22-step table in [`runbook.md`](runbook.md) § Phase 6. Each row is something that
**must be refused**. The point is for the officers to see the refusals happen with their own eyes
— that is what builds trust in the controls.

The most important ones to watch:

| Try this | It must |
|---|---|
| Submit a voucher with no attachment | **Refuse** |
| Approve a voucher you encoded yourself | **Refuse** |
| Edit a journal entry after posting | Be read-only |
| Issue two checks with the same number | **Refuse** the second |
| Finalise a bank reconciliation that is off by ₱1 | **Refuse** |
| Close a month with an unposted entry | **Refuse**, naming the entry |

**Checkpoint 6:** All three officers have seen the refusals and signed off. Write down any changes
they want **now** — after phase 10 the cost of changing the data model rises sharply.

---

# PHASE 7 — Create the real (production) Firebase project

Repeat **all of phase 2**, with one difference: name it `cbo-candoni-prod`.

Same region (`asia-southeast1`), same three services, same web app registration. Copy the six
values into Notepad under a heading **PROD**, clearly separated from the DEV set.

Then in the terminal:

```
firebase use --add
```

Select `cbo-candoni-prod`, alias it `prod`.

```
firebase use prod
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
```

Wait for the indexes to finish building, then:

```
npx tsx scripts/seed.ts --project cbo-candoni-prod
```

### 7.1 Limit who can bypass the system

Anyone with "Owner" on this project can edit the database directly, ignoring every control you
just tested.

1. Go to **https://console.cloud.google.com** → select `cbo-candoni-prod`.
2. **IAM & Admin → IAM**.
3. Owner should be **one or two people**. Everyone else who needs to look gets **Viewer**.

**Checkpoint 7:** Production has all indexes Enabled, 19 functions deployed, seeded data visible,
and a short Owner list.

> From now on, before any `firebase deploy`, run `firebase use prod` or `firebase use dev` first,
> and read the output — it tells you which project you are pointed at. Deploying dev code to prod
> by accident is easy and unpleasant.

---

# PHASE 8 — The real address: cbo.mgocandoni.com

> This changes public DNS. Do it in working hours with the Squarespace account holder reachable.
> **Nothing about the existing municipal website changes** — you are adding one record.

### 8.1 Production settings in Netlify

1. Netlify → **Site configuration → Environment variables**.
2. Add the **same eight variables again**, this time with **Scopes → Production**, using your
   **PROD** values, and `VITE_ENVIRONMENT` = `production`.

   *(Yes, each key now exists twice with different scopes. That is how Netlify keeps staging and
   production apart.)*
3. **Site configuration → Build & deploy → Branches** → set **Production branch** to `main`.

### 8.2 Tell Netlify the domain

1. **Domain management → Add a domain**.
2. Type `cbo.mgocandoni.com` → **Verify** → **Add domain**.
3. Netlify says DNS is not configured yet and shows a target like
   `candoni-books-online.netlify.app`. **Copy it exactly.**

### 8.3 Add one DNS record in Squarespace

1. Log in to **Squarespace** → **Settings → Domains → mgocandoni.com → DNS Settings**.
2. Scroll to **Custom Records** → **Add Record**.

| Field | What to put |
|---|---|
| **Host** | `cbo` |
| **Type** | `CNAME` |
| **Data** / Value | `candoni-books-online.netlify.app` |

3. **Save**.

> **Do not type `https://`.** Do not type the full `cbo.mgocandoni.com` in the Host field — just
> `cbo`.
>
> **Do not touch any other record.** Leave the root domain, `www`, and every MX and verification
> record exactly as they are. The municipal website keeps working throughout.

### 8.4 Wait, then check HTTPS

Wait 10–30 minutes. In Netlify → **Domain management**, `cbo.mgocandoni.com` should stop showing
"Awaiting external DNS".

Then under **HTTPS**, wait for the certificate to be issued (automatic), and make sure
**Force HTTPS** is switched on.

### 8.5 Let Firebase accept the real address

Firebase console (**`cbo-candoni-prod`**) → **Authentication → Settings → Authorised domains** →
**Add domain** → `cbo.mgocandoni.com`.

**Skip this and sign-in fails with an unhelpful error.**

### 8.6 Publish to production — in GitHub Desktop

Until now everything has been on the `develop` branch. This moves it to `main`, which is what
Netlify serves at the real address.

1. GitHub Desktop → **Current Branch** → switch to **main**.
2. Menu **Branch → Merge into current branch…**
3. Select **develop** → **Create a merge commit**.
4. Click **Push origin**.

Netlify builds automatically. Watch **Deploys** — about a minute.

**Checkpoint 8:**
- `https://cbo.mgocandoni.com` loads
- `http://cbo.mgocandoni.com` (no s) redirects to https
- **There is NO amber bar** — that is how you know it is production
- Typing `https://cbo.mgocandoni.com/reports/trial-balance` directly loads the page, not an error
- `https://mgocandoni.com` still shows the normal municipal website

---

# PHASE 9 — First administrator, then App Check

### 9.1 Create the first Super Administrator

1. The chosen person goes to `https://cbo.mgocandoni.com` and **signs in once** (Firebase console
   → `cbo-candoni-prod` → Authentication → Add user, to create their account first). They will see
   "Awaiting access". That is expected.
2. Firebase console → Authentication → Users → copy their **User UID** (a long string).
3. In your terminal:

```
firebase use prod
firebase functions:shell
```

Wait for the `firebase >` prompt, then type (pasting their UID):

```
setUserRoles({ uid: 'PASTE_THE_UID_HERE', roles: ['SUPER_ADMIN'] })
```

Press Enter. Then type `.exit` and press Enter.

4. They sign out and in again. They now have full access.

**This is the only time you will ever do this.** Every other role is granted inside CFMS under
**Administration → Users and Roles**.

### 9.2 Switch on App Check — last

App Check blocks requests that do not come from your real app. Turn it on only after everything
else works, because enabling it too early locks you out of your own system.

1. **https://console.cloud.google.com** → project `cbo-candoni-prod` → search **reCAPTCHA
   Enterprise** → **Create key** → type **Website** → domain `cbo.mgocandoni.com` → Create. Copy
   the **Key ID**.
2. Firebase console → **App Check** → your web app → **reCAPTCHA Enterprise** → paste the key ID →
   Save.
3. Netlify → Environment variables → add `VITE_APPCHECK_SITE_KEY` (scope: **Production**) with
   that key ID.
4. Netlify → Deploys → **Trigger deploy**.
5. **Open the site and confirm it still works.**
6. **Only then:** Firebase → App Check → for **Cloud Firestore**, **Cloud Storage** and **Cloud
   Functions**, click each and set to **Enforced**.

**Checkpoint 9:** The administrator can open every module, and the site still works with
enforcement on.

---

# PHASE 10 — Opening balances

**Read this before promising anyone a go-live date.** There is no import button, and that is
deliberate: loading a trial balance from a spreadsheet gives you a ledger where no figure can be
traced back to a document, which is the exact problem this system exists to solve.

The Accountant enters the opening position as journal entries. Full detail, including the
verification list, is in [`runbook.md`](runbook.md) § Phase 10. The order is:

1. **Master data** — offices, payees, employees, bank accounts, any missing accounts.
2. **Budget position** — appropriations enacted, allotments released, obligations still unpaid.
3. **One opening journal entry per fund**, dated the cutover date, from the last audited trial
   balance, with the difference to *Accumulated Surplus / (Deficit)* (`30101020`). It will not
   save unless it balances. Post it.
4. **Subsidiary detail** — split payables and cash advances by party, one line each. A lump sum
   makes the payables schedule unusable.
5. **Open items** — outstanding checks and deposits in transit, so the first bank reconciliation
   has something to work with.

Then verify all five: trial balance matches the audited figures, the Statement of Financial
Position balances, subsidiary ledgers agree with their controls, the budget registry matches the
Budget Office's records, and the cash position matches the last reconciliation.

Finally: **Administration → Accounting Periods** → **Close** every month before the cutover month,
so nothing can be posted into them by accident.

**Checkpoint 10:** All five verifications agree and the Accountant confirms in writing.

---

# PHASE 11 — Run both systems side by side for one month

Not two weeks. A full month, so month-end close and bank reconciliation are actually exercised.

- **Week 1** — record everything in CFMS *and* keep the existing records.
- **Week 2** — compare daily: collections, disbursements, cash position. Every difference is
  usually something missing from CFMS. Finding them now is the point.
- **Week 3** — post all journal entries; compare the trial balance to the manual books.
- **Week 4** — import the bank statement, reconcile to zero, close the period, generate every
  report and compare against the manual ones.

**Go live only when the month-end reports agree.** If they do not, find out why first. A
discrepancy carried into live operation only grows.

After cutover, keep the manual records for one more month as a fallback, then stop. Maintaining
two sets of books indefinitely is how they diverge.

---

# PHASE 12 — Keeping it running

### Every day (automatic — just read the notifications)

The system already checks overdue cash advances and undeposited collections each weekday morning,
stale checks nightly, and rebuilds every budget balance from source documents at 01:30 to prove
nothing has drifted.

### Every month

1. All vouchers approved or returned — nothing left in review.
2. All journal entries posted.
3. Bank reconciliation finalised at **zero** for every account.
4. Read the Dashboard alerts.
5. Generate and file the report set.
6. **Administration → Accounting Periods → Close** the month.

### Backups

Set up a daily Firestore export in Google Cloud Scheduler, keep 30 daily / 52 weekly / year-end
forever, and enable **Object Versioning** on the Storage bucket. Then **restore one into the dev
project once a year** — a backup nobody has ever restored is a hope, not a backup.

---

# When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `'node' is not recognised` | Node.js not installed, or no restart | Reinstall Node 22, restart the computer |
| `'firebase' is not recognised` | Firebase tool not installed | `npm install -g firebase-tools` |
| `npm ERR! EACCES` | Not enough permissions | Windows: run Command Prompt as administrator |
| `npm error ENOENT ... \functions\package.json` | You are running npm from the wrong folder — the zip extracted into nested folders of the same name | Type `dir`. It must list both `functions` and `package.json`. If not, find the real root — step 1.1 |
| `npm warn install-scripts ... not yet covered by allowScripts` | Your npm is newer than the one Node 22 ships, and it blocked esbuild's setup step. The build will fail later | Install Node 22 LTS, or run the `npm install-scripts approve` commands — step 3.3 |
| `A positional parameter cannot be found that accepts argument` | You pasted a Command Prompt command into PowerShell | Use the PowerShell version of the command, or open Command Prompt (Windows key → `cmd` → Enter) — step 1.1 |
| **Commit failed:** `nothing added to commit but untracked files present` | The repository was created one level too high — it is wrapped *around* the project folder instead of being on it | Repair the folder in step 1.1, then re-add it in step 1.2. Nothing is damaged |
| GitHub Desktop "Changes" shows **1 item**, a folder named `cbo-candoni` | Same cause as the row above | Step 1.1 repair |
| The new-repository dialog warns *"appears to be a Git repository"* | You are in **File → New repository**, which is the wrong menu | Cancel. Use **File → Add local repository** — step 1.2 |
| `auth/unauthorized-domain` at sign-in | Address not authorised | Firebase → Authentication → Settings → Authorised domains |
| `The query requires an index` | Index still building | Firestore → Indexes; wait for Enabled |
| `Missing or insufficient permissions` | Correct behaviour — you tried something your role cannot do | Check the role under Administration → Users and Roles |
| Still "Awaiting access" after granting a role | Old sign-in token | Sign out and sign in again |
| `127.0.0.1 refused to connect` (port 4000) | The emulators are not running — that window must stay open | Go to Window 1 and read what it printed; see step 3.6 |
| `firebase-tools no longer supports Java version before 21` | Java missing or older than 21 | Install Temurin **JDK 21+** — step 0.2 |
| `java -version` still shows the old version after installing | Programs opened before the install still hold the old list | Close all terminals and fully quit GitHub Desktop, then reopen. If it persists, uninstall the old Java |
| Netlify build fails | Usually a missing environment variable | Netlify → Deploys → click the failed build → read the log |
| `Your project must be on the Blaze plan` | Free plan cannot run Functions | Upgrade (phase 2.2) |
| Peso sign looks like `â‚±` in Excel | Opened the CSV, not the Excel file | Use the **Excel** export button instead |

### Undoing a bad deployment

| Problem | Fix |
|---|---|
| Website broken after a deploy | Netlify → Deploys → click the previous good one → **Publish deploy**. Instant. |
| A Cloud Function is broken | In GitHub Desktop: **History** tab → right-click the bad commit → **Revert changes in commit** → Push. Then `firebase deploy --only functions`. |
| **Bad data was posted** | **Never restore a backup over live data** — you lose everything recorded since. Reverse the journal entries instead. |

That last row is the one to remember. Code can be rolled back freely; data cannot. It is why the
system makes corrections into reversing entries rather than edits.

---

# Everything in one checklist

```
PHASE 0   [ ] Node 22 installed, computer restarted
          [ ] GitHub Desktop installed and signed in
          [ ] Four decisions written down
          [ ] Card ready for Firebase Blaze

PHASE 1   [ ] Code unzipped somewhere permanent (not OneDrive)
          [ ] Repository created in GitHub Desktop
          [ ] Published — PRIVATE ticked
          [ ] develop branch created and published
          [ ] main protected on github.com
          [ ] Actions shows a green tick

PHASE 2   [ ] cbo-candoni-dev created, Analytics off
          [ ] Blaze plan + $50 budget alert
          [ ] Authentication (Email/Password) on
          [ ] Firestore created, asia-southeast1
          [ ] Storage created
          [ ] Six DEV values saved in Notepad

PHASE 3   [ ] firebase-tools installed, logged in
          [ ] npm install (both) finished
          [ ] .env.local created correctly
          [ ] npm run verify — all six pass
          [ ] Emulators + seed + dev server running
          [ ] Test user created, made SUPER_ADMIN
          [ ] ★ ₱600,000 obligation REFUSED
          [ ] ★ ₱400,000 obligation got an OBR number

PHASE 4   [ ] firebase use --add (dev)
          [ ] Deploy complete
          [ ] All indexes say Enabled
          [ ] Seeded

PHASE 5   [ ] Netlify site connected to develop
          [ ] Eight variables, scoped to branch deploys
          [ ] Netlify address written down
          [ ] Address added to Firebase authorised domains
          [ ] Staging loads with the amber bar

PHASE 6   [ ] 22 UAT steps walked with the three officers
          [ ] Every refusal actually refused
          [ ] Signed off

PHASE 7   [ ] cbo-candoni-prod created and deployed
          [ ] Indexes Enabled, seeded
          [ ] Six PROD values saved separately
          [ ] IAM Owner list cut to 1–2 people

PHASE 8   [ ] Eight variables again, scoped to Production
          [ ] Production branch set to main
          [ ] Domain added in Netlify
          [ ] ONE CNAME added in Squarespace
          [ ] HTTPS issued, Force HTTPS on
          [ ] cbo.mgocandoni.com in Firebase authorised domains
          [ ] develop merged into main, pushed
          [ ] Live, no amber bar, deep links work
          [ ] mgocandoni.com unchanged

PHASE 9   [ ] First Super Administrator granted
          [ ] App Check configured, site still works
          [ ] Enforcement turned on

PHASE 10  [ ] Master data entered
          [ ] Budget position entered
          [ ] Opening JEV posted per fund
          [ ] Subsidiary detail split by party
          [ ] Open items recorded
          [ ] Five verifications agree
          [ ] Prior periods closed

PHASE 11  [ ] One full month parallel
          [ ] Month-end reports agree
          [ ] Cutover approved

PHASE 12  [ ] Daily backup scheduled
          [ ] Restore tested
          [ ] Monthly close routine written down
```

The two lines marked ★ are the ones that matter most. If the ₱600,000 obligation is ever allowed
through, stop and get help — everything else in the system depends on that refusal.
