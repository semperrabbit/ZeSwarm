import { filter, map, maxBy, sortBy, reduce } from 'lodash-es'
import C from '/include/constants'

export default class SpawnManager {
  constructor (context) {
    this.context = context
    this.sleeper = this.context.queryPosisInterface('sleep')
    this.spawn = this.context.queryPosisInterface('spawn')
  }
  get id () { return this.context.id }
  get memory () {
    return this.context.memory
  }
  get log () {
    return this.context.memory
  }
  get queue () {
    return this.spawn.queue
  }
  get status () {
    return this.spawn.status
  }

  run () {
    this.context.log.info(`Sleeping for 5 ticks (${Game.time})`)
    this.sleeper.sleep(5)
    if (this.queue.length) {
      let spawns = filter(Game.spawns, (spawn) => !spawn.spawning)
      for (let qi = 0; qi < this.queue.length; qi++) {
        let queue = this.queue[qi]
        let drop = []
        for (let i = 0; i < queue.length; i++) {
          if (!spawns.length) break
          let item = queue[i]
          let cspawns = map(spawns, (spawn, index) => {
            let dist = Game.map.getRoomLinearDistance(spawn.room.name, item.rooms[0])
            let energy = spawn.room.energyAvailable
            let rank = energy - (dist * 50)
            return { index, dist, energy, rank, spawn }
          })
          cspawns = sortBy(cspawns, (s) => s.rank)
          let bodies = map(item.body, (body) => {
            let cost = reduce(body, (l, v) => l + C.BODYPART_COST[v], 0)
            return { cost, body }
          })
          let { index, energy, spawn } = cspawns.pop()
          let { body } = maxBy(filter(bodies, (b) => b.cost <= energy), 'cost') || { body: false }
          if (!body) continue
          spawns.splice(index, 1)
          let status = this.status[item.statusId]
          let ret = spawn.createCreep(body, item.statusId)
          this.context.log.info(`Spawning ${item.statusId}`)
          if (typeof ret === 'string') {
            status.status = C.EPosisSpawnStatus.SPAWNING
          } else {
            status.status = C.EPosisSpawnStatus.ERROR
            status.message = this.spawnErrMsg(ret)
          }
          drop.push(i)
        }
        while (drop.length) {
          queue.splice(drop.pop(), 1)
        }
      }
    }
  }
  spawnErrMsg (err) {
    let errors = {
      [C.ERR_NOT_OWNER]: 'You are not the owner of this spawn.',
      [C.ERR_NAME_EXISTS]: 'There is a creep with the same name already.',
      [C.ERR_BUSY]: 'The spawn is already in process of spawning another creep.',
      [C.ERR_NOT_ENOUGH_ENERGY]: 'The spawn and its extensions contain not enough energy to create a creep with the given body.',
      [C.ERR_INVALID_ARGS]: 'Body is not properly described.',
      [C.ERR_RCL_NOT_ENOUGH]: 'Your Room Controller level is insufficient to use this spawn.'
    }
    return errors[err]
  }
}