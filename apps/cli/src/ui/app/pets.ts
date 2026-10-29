import { createPetPickerState } from "../lazy-pages"
import type { AppContext } from "./context"
import { followPet } from "./pet-follow"
import type { TuiProfile } from "../../view/tui-profile"

export function createPets(ctx: AppContext, actions: { changeProfile(patch: Partial<TuiProfile>): void }) {
  const { input, state, requestFrame, now, say } = ctx

  async function packagePets() {
    if (!input.pets || input.remote) return
    const reply = await input.send({ type: "packages.list", directory: input.directory ?? "" })
    input.pets.dirs.splice(0, input.pets.dirs.length, ...input.pets.dirs.filter((entry) => entry.source !== "package"))
    if (!reply.ok) return
    const report = reply.result as import("@mendcode/protocol").PackagesReport | undefined
    const { join } = await import("node:path")
    for (const entry of report?.packages ?? []) if (entry.enabled && !entry.problem) input.pets.dirs.push({ source: "package", dir: join(entry.dir, "pets") })
  }

  /** What the start screen shows as its mascot: a pet's reference, `mend`, or `off` for the title alone. */
  const mascotNow = () => (state.tuiProfile.logoKind === "mascot" || state.tuiProfile.logoKind === "both" ? state.tuiProfile.homeMascot : "off")

  async function loadPetChoices() {
    await packagePets()
    const [{ defaultHomeMascot, defaultActivityMascotStates }, { mendSpriteLines }, { activeTheme }] = await Promise.all([import("../../view/mascot"), import("../../view/mend-sprite"), import("../theme")])
    // Colored half blocks wherever the theme has true colors; v1's text mascot on a 16-color palette.
    const preview = activeTheme().ansi === undefined ? mendSpriteLines("idle", 2) : defaultHomeMascot.split("\n").map((text) => [{ text, fg: "text" as const }])
    const [{ petChoices, PET_PREVIEW_BOX }, { mendCells, mendPicture }] = await Promise.all([import("../../pets/pet-slot"), import("../../pets/mend-pet")])
    // Its picture takes the cells any pet's does; the half blocks stay whole pixels, which cannot be smaller than half a cell.
    const cells = mendCells(PET_PREVIEW_BOX.cols, PET_PREVIEW_BOX.rows)
    const { image } = mendPicture("idle", cells.cols, cells.rows, { width: 8, height: 16 })
    const official = { ref: "mend", name: "MendAscii", description: "The official Mend mascot, MendGirl's little robot drawn in colored blocks; its eyes follow what the session does", source: "Built-in", states: Object.keys(defaultActivityMascotStates), preview, ...(activeTheme().ansi === undefined ? { image, cells } : {}) }
    const choices = input.pets ? await petChoices(input.pets) : []
    state.petList = [official, ...choices.map(({ pet: info, image, preview, cells, states }) => ({ ref: info.ref, name: info.displayName, description: info.description, source: info.layout ? "imported" : info.ref.split(":")[0]!, states, ...(info.generatedStates ? { generated: info.generatedStates } : {}), ...(info.layout ? { imported: true } : {}), ...(preview ? { preview } : {}), ...(image ? { image } : {}), ...(cells ? { cells } : {}) }))]
    state.petPicker = createPetPickerState(state.petList, state.petPickerMascot ? mascotNow() : state.tuiProfile.pet || state.settingsNow.pet)
    requestFrame()
  }

  async function selectPet(requested: string | undefined) {
    // Screen-reader mode shows no pet: it is decoration a reader would only describe.
    const ref = state.accessible ? "off" : requested
    if (ref === "mend") {
      await state.pet?.choose("off")
      requestFrame()
      return
    }
    if (!input.pets || (!state.pet && (!ref || ref === "off"))) return
    if (ref?.startsWith("package:")) await packagePets()
    if (!state.pet) {
      const { createPetSlot } = await import("../../pets/pet-slot")
      state.pet ??= createPetSlot({ ...input.pets, now, reducedMotion: () => state.reducedMotion || input.screen.imageProtocol === "iterm2" || input.screen.imageProtocol === "sixel", onChange: requestFrame, say: (message) => say(message, "warning") })
      followPet(state)
    }
    await state.pet.choose(ref)
  }

  let settled: Promise<unknown> = Promise.resolve()
  function choosePet(ref: string | undefined) {
    const task = selectPet(ref)
    settled = Promise.allSettled([settled, task])
    return task
  }

  /** Settles when every pet choice started so far has loaded (tests and scripts wait on it instead of sleeping). */
  const petReady = () => settled.then(() => undefined)

  async function petCommand(text: string) {
    const { parsePetCommand } = await import("../../pet-command")
    try {
      const command = parsePetCommand(text)
      if (!command) return false
      if (input.remote || !input.pets) throw new Error("Pet management is local only")
      if (state.petGenerating) throw new Error("Pet generation is in progress")
      if (command.action === "import") {
        // The daemon reads the file: it gets the full path, `~` and a path relative to the project resolved here.
        const { isAbsolute, resolve } = await import("node:path")
        const typed = input.home && (command.path === "~" || command.path.startsWith("~/")) ? input.home + command.path.slice(1) : command.path
        command.path = isAbsolute(typed) ? typed : resolve(input.directory ?? ".", typed)
      }
      const reply = await input.send({ type: "pet.manage", input: command })
      if (!reply.ok) throw new Error(reply.error.message)
      if (command.action === "import") {
        const made = reply.result as { ref: string; name: string; art: string; frames: number; states: string[]; notes: string[] }
        state.petPickerMascot = false
        await loadPetChoices()
        state.petPicker = createPetPickerState(state.petList ?? [], made.ref)
        state.page = "pet"
        for (const note of made.notes) say(note, "info")
        say(`Pet ${made.name} imported · ${made.frames === 1 ? "still" : `${made.frames} frames`} · ${made.art} art · enter selects it · /mascot ${/\s/.test(made.name) ? `"${made.name}"` : made.name} for the start screen`, "success")
      } else if (reply.result?.plan) {
        state.petPlan = reply.result.plan as import("../../../../../packages/protocol/src/pet-data").PetPlan
        state.petPlanError = undefined
        state.page = "pet"
      } else {
        if (command.action === "delete" && (state.tuiProfile.pet || state.settingsNow.pet) === `user:${command.petId}`) {
          await choosePet("off")
          actions.changeProfile({ pet: "off" })
          await ctx.setupChoice({ pet: null })
        }
        // A deleted pet cannot stay the start-screen mascot: the ASCII Mend takes its place.
        if (command.action === "delete" && state.tuiProfile.homeMascot === `user:${command.petId}`) actions.changeProfile({ homeMascot: "mend" })
        await loadPetChoices()
        state.page = "pet"
        say(command.action === "export" ? `Pet package: ${reply.result?.directory}` : command.action === "delete" ? "Pet moved to Trash" : "Pet renamed", "success")
      }
      requestFrame()
      return true
    } catch (error) {
      say(error instanceof Error ? error.message : "Pet operation failed", "error")
      return true
    }
  }

  async function petPlanKey(key: string) {
    if (!state.petPlan) return false
    if (state.petGenerating) return true
    if (key === "\x1b") {
      state.petPlan = undefined
      state.petProgress = undefined
      state.page = "chat"
      requestFrame()
      return true
    }
    if (key !== "y") return true
    state.petGenerating = true
    state.petPlanError = undefined
    state.petProgress = undefined
    requestFrame()
    const planId = state.petPlan.planId
    let running = true
    const refresh = async (final = false) => {
      const status = await input.send({ type: "pet.manage", input: { action: "status", planId } }).catch(() => undefined)
      const progress = status?.ok ? status.result?.progress : undefined
      if (progress && (running || final)) {
        state.petProgress = progress as NonNullable<typeof state.petProgress>
        requestFrame()
      }
    }
    // The generate call answers once, at the end; the rows between come from the daemon's own record of its calls.
    void (async () => {
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (running) await refresh()
      }
    })()
    try {
      const generation = input.send({ type: "pet.manage", input: { action: "generate", planId, confirmed: true } })
      const reply = await generation.finally(() => { running = false })
      if (!reply.ok) {
        await refresh(true)
        throw new Error(reply.error.message)
      }
      await choosePet("off")
      state.petPlan = undefined
      state.petProgress = undefined
      await loadPetChoices()
      const ref = reply.result?.ref as string
      state.petPicker = createPetPickerState(state.petList ?? [], ref)
      state.page = "pet"
      say("Pet ready · enter to select", "success")
    } catch (error) {
      state.petPlanError = `${error instanceof Error ? error.message : "Pet generation failed"}. Cancel and create a new plan.`
    } finally {
      state.petGenerating = false
      requestFrame()
    }
    return true
  }

  /** Installed pets by name, for `/mascot` and the Mascot row: a pet answers to its name, its id or its full reference. */
  async function petNames(): Promise<Array<{ ref: string; id: string; name: string }>> {
    if (!input.pets) return []
    await packagePets()
    const { listPets } = await import("../../pets/manifest")
    return (await listPets(input.pets.dirs)).pets.map((pet) => ({ ref: pet.ref, id: pet.id, name: pet.displayName }))
  }

  return { loadPetChoices, choosePet, petReady, petCommand, petPlanKey, petNames, mascotNow }
}
