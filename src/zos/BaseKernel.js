import Logger from './Logger'
import InterruptHandler from './InterruptHandler'

import MemoryManager from './MemoryManager'
import Scheduler from './Scheduler'

import ErrorMapper from './ErrorMapper'

import C from './constants'

// export interface ProcessInfo {
//   id: PosisPID
//   pid: PosisPID
//   name: string
//   status: string
//   started: number
//   wake?: number
//   ended?: number
//   process?: IPosisProcess
//   error?: string
// }

// export interface ProcessTable {
//   [id: string]: ProcessInfo
// }

// export interface ProcessMemoryTable {
//   [id: string]: {}
// }

// export interface KernelMemory {
//   processTable: ProcessTable
//   processMemory: ProcessMemoryTable
// }

// declare global {
//   interface Memory {
//     kernel: KernelMemory
//   }
// }

export class BaseKernel { // implements IPosisKernel, IPosisSleepExtension {
  get memory () {
    return this.memget()
  }
  get processTable () {
    this.memory.processTable = this.memory.processTable || {}
    return this.memory.processTable
  }
  get processMemory () {
    Memory.zos = Memory.zos || {}
    Memory.zos.processMemory = Memory.zos.processMemory || {}
    return Memory.zos.processMemory
  }

  get uptime () {
    return (Game.time - this.time) + 1
  }

  constructor (processRegistry, extensionRegistry) {
    this.time = Game.time
    this.rand = Game.time % 10
    this.segments = extensionRegistry.getExtension('segments')
    this.scheduler = new Scheduler(this)
    this.segments.activate(C.SEGMENTS.KERNEL)
    this.mem = this.segments.load(C.SEGMENTS.KERNEL)
    if (this.mem === '') this.mem = {}
    if (this.imem === '') this.imem = {}

    this.memget = () => this.mem
    this.processRegistry = processRegistry
    this.extensionRegistry = extensionRegistry

    this.interruptHandler = new InterruptHandler(() => {
      let mem = this.segments.load(C.SEGMENTS.INTERRUPT)
      if (mem === '') {
        mem = {}
        this.segments.save(C.SEGMENTS.INTERRUPT, mem)
      }
      return mem
    })
    this.processInstanceCache = {}
    this.currentId = 'ROOT'
    this.log = new Logger('[Kernel]')
    // if (!Memory.spawnVersion) {
    //   Memory.spawnVersion = _.find(Game.spawns, a=>a).id
    // }
    // if (Memory.spawnVersion && Memory.spawnVersion !== _.find(Game.spawns, a=>a).id) {
    //   this.reboot()
    //   throw new Error('Reboot Forced')
    // }
  }

  UID () {
    return ('P' + Game.time.toString(36).slice(-6) + Math.random().toString(36).slice(-3)).toUpperCase()
  }

  allowSuper (imageName) {
    return !!imageName.match(/^ags131\//)
  }

  startProcess (imageName, startContext) { // : { pid: PosisPID; process: IPosisProcess; } | undefined {
    let id = this.UID()

    let pinfo = {
      i: id,
      p: this.currentId,
      n: imageName,
      s: C.PROC_RUNNING,
      S: Game.time,
      x: this.allowSuper(imageName)
    }
    this.processTable[id] = pinfo
    this.processMemory[pinfo.i] = startContext || undefined
    let process = this.createProcess(id)
    this.log.debug(() => `startProcess ${imageName}`)
    this.scheduler.addProcess(pinfo)
    return { pid: id, process }
  }

  queryPosisInterface (ext) {
    return this.extensionRegistry.getExtension(ext)
  }

  queryPosisInterfaceSuper (ext) {
    if (ext === 'zos/kernel') {
      return this
    }
    return this.extensionRegistry.getExtension(ext)
  }

  createProcess (id) {
    this.log.debug(() => `createProcess ${id}`)
    let pinfo = this.processTable[id]
    if (!pinfo || pinfo.s !== C.PROC_RUNNING) throw new Error(`Process ${pinfo.i} ${pinfo.n} not running`)
    const self = this
    const qpi = pinfo.x ? this.queryPosisInterfaceSuper : this.queryPosisInterface
    let context = {
      id: pinfo.i,
      get parentId () {
        return (self.processTable[id] && self.processTable[id].pid) || ''
      },
      imageName: pinfo.n,
      log: new Logger(`[${pinfo.i}) ${pinfo.n}]`),
      get memory () {
        self.processMemory[pinfo.i] = self.processMemory[pinfo.i] || {}
        return self.processMemory[pinfo.i]
      },
      queryPosisInterface: qpi.bind(self)
    }
    Object.freeze(context)
    let process = this.processRegistry.getNewProcess(pinfo.n, context)
    if (!process) throw new Error(`Could not create process ${pinfo.i} ${pinfo.n}`)
    this.processInstanceCache[id] = { context, process }
    return process
  }

  // killProcess also kills all children of this process
  // note to the wise: probably absorb any calls to this that would wipe out your entire process tree.
  killProcess (id) {
    let pinfo = this.processTable[id]
    if (!pinfo) return
    this.log.warn(() => `killed ${id}`)
    pinfo.s = C.PROC_KILLED
    pinfo.e = Game.time
    this.interruptHandler.clear(id)
    if (pinfo.p === '') return
    let ids = Object.keys(this.processTable)
    for (let i = 0; i < ids.length; i++) {
      let id = ids[i]
      let pi = this.processTable[id]
      if (pi.pid === pinfo.i) {
        if (pi.status === C.PROC_RUNNING) {
          this.killProcess(id)
        }
      }
    }
  }

  getProcessById (id) {
    return this.processTable[id] &&
      this.processTable[id].s === C.PROC_RUNNING &&
      ((this.processInstanceCache[id] &&
        this.processInstanceCache[id].process) ||
        this.createProcess(id))
  }

  getChildren (id) {
    return map(filter(this.processTable, (p) => p.p === id), (p) => this.getProcessById(p.i))
  }

  // passing undefined as parentId means 'make me a root process'
  // i.e. one that will not be killed if another process is killed
  setParent (id, parentId = 'ROOT') {
    if (!this.processTable[id]) return false
    this.processTable[id].pid = parentId
    return true
  }

  setInterrupt (type, stage, key) {
    return this.interruptHandler.add(this.currentId, type, stage, key)
  }

  clearInterrupt (type, stage, key) {
    return this.interruptHandler.remove(this.currentId, type, stage, key)
  }
  clearAllInterrupts () {
    return this.interruptHandler.clear(this.currentId)
  }
  runProc (id, func = 'run', ...params) {
    let pinfo = this.processTable[id]
    if (!pinfo) return false
    if (pinfo.s !== C.PROC_RUNNING && pinfo.e < Game.time - 5) {
      delete this.processMemory[id]
      delete this.processTable[id]
    }
    if (pinfo.s !== C.PROC_RUNNING) return false
    let parentInfo = this.processTable[pinfo.p]
    if (pinfo.p !== 'ROOT' && (!parentInfo || parentInfo.s !== C.PROC_RUNNING)) {
      this.killProcess(id)
      pinfo.Eq = 'Missing Parent'
      this.log.error(() => `[${id}] ${pinfo.n} missing parent, reaping.`)
      return false
    }
    if (func === C.INT_FUNC.WAKE) {
      delete pinfo.w
    } else if (pinfo.w > Game.time) {
      return false
    } else {
      delete pinfo.w
    }
    try {
      let proc = this.getProcessById(id)
      if (!proc) throw new Error(`Could not get process ${id} ${pinfo.n}`)
      if (proc[func]) {
        this.currentId = id
        proc[func](...params)
        this.currentId = 'ROOT'
      }
      return true
    } catch (e) {
      this.killProcess(id)
      this.currentId = 'ROOT'
      let err = e
      try {
        err = ErrorMapper.map(err)
      } catch (e) {
        // Couldn't remap
        this.log.warn(() => `Unable to remap error`)
        err = e.stack || e
      }
      pinfo.Eq = err.toString()
      this.log.error(() => `[${id}] ${pinfo.n} crashed\n${err}`)
      return false
    }
  }
  pretick() {
    this.ktime = 0
    const start = Game.cpu.getUsed()
    this.mem = this.segments.load(C.SEGMENTS.KERNEL)
    this.imem = this.segments.load(C.SEGMENTS.INTERRUPT)
    if (this.mem === '') this.mem = {}
    if (this.imem === '') this.imem = {}
    if (Game.time % 10 === this.rand) {
      let ids = Object.keys(this.processMemory)
      this.log.info(`Cleaning Process Memory... (${ids.length} items)`)
      for (let i = 0; i < ids.length; i++) {
        let id = ids[i]
        if (!this.processTable[id] || Object.keys(this.processMemory[id] || {}).length === 0) {
          delete this.processMemory[id]
        }
      }
    }
    if (Game.time % 10 === (this.rand + 5) % 10) {
      let ids = Object.keys(this.processTable)
      this.log.info(`Cleaning Process Table... (${ids.length} items)`)
      for (let i = 0; i < ids.length; i++) {
        let id = ids[i]
        if (this.processTable[id].s !== C.PROC_RUNNING) {
          delete this.processTable[id]
        }
      }
    }
    _.each(Memory.creeps, (c, name) => {
      if (!Game.creeps[name]) {
        delete Memory.creeps[name]
      }
    })
    const end = Game.cpu.getUsed()
    this.ktime += end - start

  }
  loop () {
    let loopStart = Game.cpu.getUsed()
    let procUsed = 0
    if (this.mem === false || this.imem === false) {
      this.log.warn(`Kernel Segments not loaded. Activating. Break early. ${C.SEGMENTS.KERNEL} ${C.SEGMENTS.INTERRUPT}`)
      this.segments.activate(C.SEGMENTS.KERNEL)
      this.segments.activate(C.SEGMENTS.INTERRUPT)
      return
    }
    if (!this.mem.type === 'kernel') {
      this.mem = { type: 'kernel' }
      this.segments.save(C.SEGMENTS.KERNEL, this.mem)
    }
    if (!this.imem.type === 'interrupt') {
      this.imem = { type: 'interrupt' }
      this.segments.save(C.SEGMENTS.INTERRUPT, this.imem)
    }
    this.memory.processTable = this.memory.processTable || {}
    let interrupts = this.interruptHandler.run(C.INT_STAGE.START)
    _.each(interrupts, ([hook, key]) => {
      let start = Game.cpu.getUsed()
      let func = C.INT_FUNC[hook.func] || hook.func
      let ret = this.runProc(hook.pid, func || C.INT_FUNC.INTERRUPT, { hook, key })
      let end = Game.cpu.getUsed()
      procUsed += end - start
      if (ret === false || hook.func === C.INT_FUNC.WAKE) {
        this.interruptHandler.remove(hook.pid, hook.type, hook.stage, hook.key)
      }
    })

    let cnt = this.scheduler.setup()
    if (cnt === 0) {
      this.startProcess('init', {})
    }

    let stats = []
    this.log.debug('loop')
    while (true) {
      let pid = this.scheduler.getNextProcess()
      this.log.debug('pid', pid)
      if (pid === false) { // Hard stop
        _.each(stats, stat => {
          this.log.debug(`-- ${stat.id} ${stat.cpu.toFixed(3)} ${stat.end.toFixed(3)} ${stat.pinfo.n}`)
        })
      }
      if (!pid) break
      this.log.debug('process')
      let start = Game.cpu.getUsed()
      this.runProc(pid)
      let end = Game.cpu.getUsed()
      let dur = end - start
      let ts
      let te
      ts = Game.cpu.getUsed()
      this.scheduler.setCPU(pid, dur.toFixed(3))
      let pinfo = this.getProcessById(pid)
      if (pinfo === false) {
        this.log.info(`Stats collection: PID ${pid} was not found`)
        return
      }
      pinfo.c = dur
      procUsed += dur
      te = Game.cpu.getUsed()
      this.log.debug(() => `${pinfo.i} scheduler setCPU ${(te - ts).toFixed(3)}`)
      ts = Game.cpu.getUsed()
      global.stats.addStat('process', {
        name: pinfo.context.imageName
      }, {
        cpu: dur
        // id: pinfo.i,
        // parent: pinfo.p
      })
      te = Game.cpu.getUsed()
      this.log.debug(() => `${pinfo.i} influx addStat ${(te - ts).toFixed(3)}`)
      ts = Game.cpu.getUsed()
      stats.push({
        pinfo,
        cpu: dur,
        id: pinfo.i,
        end,
        parent: pinfo.p
      })
      te = Game.cpu.getUsed()
      this.log.debug(() => `${pinfo.i} stats push ${(te - ts).toFixed(3)}`)
    }
    this.scheduler.cleanup()
    interrupts = this.interruptHandler.run(C.INT_STAGE.END)
    _.each(interrupts, ([hook, key]) => {
      let start = Game.cpu.getUsed()
      let func = C.INT_FUNC[hook.func] || hook.func
      let ret = this.runProc(hook.pid, func || C.INT_FUNC.INTERRUPT, { hook, key })
      let end = Game.cpu.getUsed()
      procUsed += end - start
      if (ret === false || hook.func === C.INT_FUNC.WAKE) {
        this.interruptHandler.remove(hook.pid, hook.type, hook.stage, hook.key)
      }
    })
    this.segments.save(C.SEGMENTS.KERNEL, this.memory)
    this.segments.save(C.SEGMENTS.INTERRUPT, this.segments.load(C.SEGMENTS.INTERRUPT))
    let loopEnd = Game.cpu.getUsed()
    let loopDur = loopEnd - loopStart
    this.ktime += loopDur - procUsed
    if (!RawMemory.segments[C.SEGMENTS.KERNEL]) {
      this.log.error('ERROR: Segment not saved! Too big?')
    }
    this.log.info(`CPU Used: ${Game.cpu.getUsed().toFixed(3)}, uptime: ${this.uptime}, ktime: ${this.ktime.toFixed(3)}, ptime: ${procUsed.toFixed(3)}, kmem: ${RawMemory.segments[C.SEGMENTS.KERNEL] && RawMemory.segments[C.SEGMENTS.KERNEL].length}, imem: ${RawMemory.segments[C.SEGMENTS.INTERRUPT] && RawMemory.segments[C.SEGMENTS.INTERRUPT].length}`)
  }

  sleep (ticks) {
    this.processTable[this.currentId].w = Game.time + ticks
    // this.wait(C.INT_TYPE.SLEEP, C.INT_STAGE.START, Game.time + ticks, C.INT_FUNC.WAKE)
  }

  wait (type, stage, key) {
    this.interruptHandler.add(this.currentId, type, stage, key, C.INT_FUNC.WAKE)
    this.processTable[this.currentId].w = true
  }

  reboot () {
    this.extensionRegistry.reboot()
    this.segments.save(C.SEGMENTS.KERNEL, {})
    this.segments.posttick()
  }
}
