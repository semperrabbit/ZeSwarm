import Logger from './Logger'

let logger = new Logger('[ExtensionRegistry]')
logger.level = Logger.LogLevel.DEBUG

export class ExtensionRegistry {
  constructor () {
    this.registry = {} // [interfaceId: string]: IPosisExtension } = {}
    this.register('agsExtensionRegistry', this)
  }
  register (interfaceId, extension) {
    if (this.registry[interfaceId]) {
      logger.warn(`Interface Id already registered: ${interfaceId}`)
    }
    logger.debug(`Registered ${interfaceId}`)
    this.registry[interfaceId] = extension
    return true
  }
  unregister (interfaceId) {
    if (this.registry[interfaceId]) {
      logger.debug(`Unregistered ${interfaceId}`)
      delete this.registry[interfaceId]
      return true
    } else {
      logger.error(`Interface Id not registered: ${interfaceId}`)
      return false
    }
  }
  getExtension (interfaceId) {
    if (!this.registry[interfaceId]) return
    return this.registry[interfaceId]
  }
}
