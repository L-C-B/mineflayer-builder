const { goals, Movements } = require('mineflayer-pathfinder')
const toolPlugin = require('mineflayer-tool').plugin
const { Vec3 } = require('vec3')

const interactable = require('./lib/interactable.json')

function wait (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function inject (bot, options = {}) {
  if (!bot.pathfinder) {
    throw new Error('pathfinder must be loaded before builder')
  }
  bot.loadPlugin(toolPlugin)

  const mcData = require('minecraft-data')(bot.version)
  const Item = require('prismarine-item')(bot.version)

  const defaultOptions = {
    buildSpeed: 1.0,
    onError: 'pause',
    bots: [bot]
  }
  const settings = { ...defaultOptions, ...options }

  const movements = new Movements(bot, mcData)
  movements.digCost = 10
  movements.maxDropDown = 256
  bot.pathfinder.searchRadius = 10

  bot.builder = {}
  let currentBuild = null

  async function equipItem (id, destination = 'hand') {
    const itemInInventory = bot.inventory.findInventoryItem(id, null)
    if (itemInInventory) {
      await bot.equip(itemInInventory, destination)
      return
    }

    if (bot.creative.gamemode) {
      if (bot.inventory.items().length > 30) {
        bot.chat('/clear')
        await wait(1000)
      }
      const item = new Item(id, 1)
      const slot = bot.inventory.firstEmptyInventorySlot()
      await bot.creative.setInventorySlot(slot !== null ? slot : 36, item)
      await bot.equip(item, destination)
    } else {
      throw new Error(`Missing item ${id} in inventory`)
    }
  }

  bot.builder.build = async (build) => {
    currentBuild = build
    try {
      while (build.actions.length > 0 && !build.isCancelled) {
        if (build.isPaused) {
          await wait(1000)
          continue
        }

        const actions = build.getAvailableActions()
        if (actions.length === 0) {
          console.log('No actions to perform')
          break
        }

        actions.sort((a, b) => {
          const dA = a.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position)
          const dB = b.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position)
          return dA - dB
        })

        const action = actions[0]

        try {
          if (action.type === 'place') {
            const item = build.getItemForState(action.state)
            console.log('Selecting ' + item.displayName)

            const properties = build.properties[action.state]
            const half = properties.half ? properties.half : properties.type

            const faces = build.getPossibleDirections(action.state, action.pos)

            const { facing, is3D } = build.getFacing(action.state, properties.facing)
            const goal = new goals.GoalPlaceBlock(action.pos, bot.world, {
              faces,
              facing: facing,
              facing3D: is3D,
              half
            })

            if (!goal.isEnd(bot.entity.position.floored())) {
              console.log('pathfinding')
              bot.pathfinder.setMovements(movements)
              await bot.pathfinder.goto(goal)
            }

            await equipItem(item.id)

            const faceAndRef = goal.getFaceAndRef(bot.entity.position.floored().offset(0.5, 1.6, 0.5))
            if (!faceAndRef) { throw new Error('no face and ref') }

            bot.lookAt(faceAndRef.to, true)

            const refBlock = bot.blockAt(faceAndRef.ref)
            const sneak = interactable.indexOf(refBlock.name) > 0
            const delta = faceAndRef.to.minus(faceAndRef.ref)
            if (sneak) bot.setControlState('sneak', true)
            await bot._placeBlockWithOptions(refBlock, faceAndRef.face.scaled(-1), { half, delta })
            if (sneak) bot.setControlState('sneak', false)

            const block = bot.world.getBlock(action.pos)
            if (block.stateId !== action.state) {
              console.log('expected', properties)
              console.log('got', block.getProperties())
              throw new Error('Block placement failed')
            }
          } else if (action.type === 'dig') {
            const blockToDig = bot.blockAt(action.pos)
            if (!blockToDig) throw new Error(`No block at ${action.pos}`)
            await bot.tool.equipForBlock(blockToDig, {})
            await bot.dig(blockToDig)
          }

          build.removeAction(action)
          bot.emit('builder_progress', build.getProgress())
          await wait(Math.round(1000 / settings.buildSpeed))
        } catch (e) {
          console.log(e)
          bot.emit('builder_error', e)
          if (settings.onError === 'pause') {
            build.pause()
            bot.emit('builder_paused')
            break
          } else if (settings.onError === 'cancel') {
            build.cancel()
            bot.emit('builder_cancelled')
            break
          }
        }
      }

      if (!build.isCancelled) {
        bot.emit('builder_finished')
      }
    } catch (e) {
      console.log(e)
      bot.emit('builder_error', e)
    } finally {
      currentBuild = null
    }
  }

  bot.builder.pause = () => {
    if (currentBuild) {
      currentBuild.pause()
      bot.emit('builder_paused')
    }
  }

  bot.builder.resume = () => {
    if (currentBuild) {
      currentBuild.resume()
      bot.emit('builder_resumed')
    }
  }

  bot.builder.cancel = () => {
    if (currentBuild) {
      currentBuild.cancel()
    }
  }

  bot.builder.getProgress = () => {
    if (currentBuild) {
      return currentBuild.getProgress()
    }
    return null
  }

  bot.builder.chest = async (coords) => {
    const [x, y, z] = coords.split(',').map(coord => parseInt(coord.trim()))
    const chestPos = new Vec3(x, y, z)

    const chestBlock = bot.blockAt(chestPos)
    if (!chestBlock || chestBlock.name !== 'chest') {
      return
    }

    try {
      const chest = await bot.openChest(chestBlock)

      const neededItems = currentBuild.getNeededItems()
      for (const item of neededItems) {
        const inventoryItem = bot.inventory.findInventoryItem(item.id, item.metadata)
        const count = inventoryItem ? inventoryItem.count : 0
        if (count < item.count) {
          await chest.withdraw(item.id, item.metadata, item.count - count)
        }
      }
      await chest.close()
    } catch (err) {
      bot.emit('builder_error', err)
    }
  }
}

module.exports = {
  Build: require('./lib/Build.js'),
  builder: inject
}
