#!/usr/bin/env node
var fs = require('fs')
var Cabal = require('cabal-core')
var minimist = require('minimist')
var os = require('os')
var fs = require('fs')
var path = require('path')
var yaml = require('js-yaml')
var mkdirp = require('mkdirp')
var frontend = require('./neat-screen.js')
var crypto = require('hypercore-crypto')
var chalk = require('chalk')
var ram = require('random-access-memory')
var level = require('level')
var memdb = require('memdb')
var cabalDns = require('dat-dns')({
  hashRegex: /^[0-9a-f]{64}?$/i,
  recordName: 'cabal',
  protocolRegex: /^cabal:\/\/([0-9a-f]{64})/i,
  txtRegex: /^"?cabalkey=([0-9a-f]{64})"?$/i,
  persistentCache: {
    read: async function (name, err) {
      if (name in config.cache) {
        var cache = config.cache[name]
        if (cache.expiresAt < Date.now()) { // if ttl has expired: warn, but keep using
          console.error(`${chalk.redBright('Note:')} the TTL for ${name} has expired`)
        }
        return cache.key
      }
      // dns record wasn't found online and wasn't in the cache
      throw err
    },
    write: async function (name, key, ttl) {
      var expireOffset = +(new Date(ttl * 1000)) // convert to epoch time
      var expiredTime = Date.now() + expireOffset
      config.cache[name] = { key: key, expiresAt: expiredTime }
      saveConfig(configFilePath, config)
    }
  }
})

var args = minimist(process.argv.slice(2))

var homedir = os.homedir()
var rootdir = args.dir || (homedir + `/.cabal/v${Cabal.databaseVersion}`)
var rootconfig = `${rootdir}/config.yml`
var archivesdir = `${rootdir}/archives/`

var usage = `Usage
  cabal cabal://key
  cabal <your saved --alias of a cabal>

  OR

  cabal --new

  Options:
    --seed    Start a headless seed for the specified cabal key

    --new     Start a new cabal
    --nick    Your nickname
    --alias   Save an alias for the specified cabal, use with --key
    --aliases Print out your saved cabal aliases
    --forget  Forgets the specified alias
    --clear   Clears out all aliases
    --key     Specify a cabal key. Used with --alias
    --join    Only join the specified cabal, disregarding whatever is in the config
    --config  Specify a full path to a cabal config

    --temp    Start the cli with a temporary in-memory database. Useful for debugging
    --version Print out which version of cabal you're running
    --help    Print this help message

    --message Publish a single message; then quit after \`timeout\`
    --channel Channel name to publish to for \`message\` option; default: "default"
    --timeout Delay in milliseconds to wait on swarm before quitting for \`message\` option; default: 5000
    --type    Message type set to message for \`message\` option; default: "chat/text"

Work in progress! Learn more at https://github.com/cabal-club
`

if (args.version || args.v) {
  console.log(JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version)
  process.exit(0)
}

if (args.help || args.h) {
  process.stderr.write(usage)
  process.exit(1)
}

var config
var cabalKeys = []
var configFilePath = findConfigPath()
var maxFeeds = 1000

// make sure the .cabal/v<databaseVersion> folder exists
mkdirp.sync(rootdir)

// create a default config in rootdir if it doesn't exist
if (!fs.existsSync(rootconfig)) {
  saveConfig(rootconfig, { cabals: [], aliases: {}, cache: {} })
}

// Attempt to load local or homedir config file
try {
  if (configFilePath) {
    config = yaml.safeLoad(fs.readFileSync(configFilePath, 'utf8'))
    if (!config.cabals) { config.cabals = [] }
    if (!config.aliases) { config.aliases = {} }
    if (!config.cache) { config.cache = {} }
    cabalKeys = config.cabals
  }
} catch (e) {
  logError(e)
  process.exit(1)
}

if (args.clear) {
  delete config['aliases']
  saveConfig(configFilePath, config)
  process.stdout.write('Aliases cleared\n')
  process.exit(0)
}

if (args.forget) {
  delete config.aliases[args.forget]
  saveConfig(configFilePath, config)
  process.stdout.write(`${args.forget} has been forgotten`)
  process.exit(0)
}

if (args.aliases) {
  var aliases = Object.keys(config.aliases)
  if (aliases.length === 0) {
    process.stdout.write("You don't have any saved aliases.\n\n")
    process.stdout.write(`Save an alias by running\n`)
    process.stdout.write(`${chalk.magentaBright('cabal: ')} ${chalk.greenBright('--alias cabal://c001..c4b41')} `)
    process.stdout.write(`${chalk.blueBright('--key your-alias-name')}\n`)
  } else {
    aliases.forEach(function (alias) {
      process.stdout.write(`${chalk.blueBright(alias)}\t\t ${chalk.greenBright(config.aliases[alias])}\n`)
    })
  }
  process.exit(0)
}

if (args.alias && !args.key) {
  logError('the --alias option needs to be used together with --key')
  process.exit(1)
}

// user wants to alias a cabal:// key with a name
if (args.alias && args.key) {
  config.aliases[args.alias] = args.key
  saveConfig(configFilePath, config)
  console.log(`${chalk.magentaBright('cabal:')} saved ${chalk.greenBright(args.key)} as ${chalk.blueBright(args.alias)}`)
  process.exit(0)
}

if (args.key) {
  // If a key is provided, place it at the top of the list
  cabalKeys.unshift(args.key)
} else if (args._.length > 0) {
  // the cli was run as `cabal <alias|key> ... <alias|key>`
  args._.forEach(function (str) {
    cabalKeys.unshift(getKey(str))
  })
} else if (args.temp) {
    // the cli was run as `cabal --temp cabal://asdasd..` which accidentally consume the key and puts it into --temp
    cabalKeys.unshift(getKey(args.temp))
}

// disregard config
if (args.join) {
  cabalKeys = [getKey(args.join)]
}

// set maximum number of hypercores to replicate
if (args.maxFeeds) {
  maxFeeds = args.maxFeeds
}

// only enable multi-cabal under the --experimental flag
if (!args.experimental && cabalKeys.length) {
  var firstKey = cabalKeys[0]
  cabalKeys = [firstKey]
}

function createCabal (key) {
  return cabalDns.resolveName(key).then(function (key) {
    key = key.replace('cabal://', '').replace('cbl://', '').replace('dat://', '').replace(/\//g, '')
    var storage = args.temp ? ram : archivesdir + key
    if (!args.temp) try { mkdirp.sync(path.join(archivesdir, key, 'views')) } catch (e) {}
    var db = args.temp ? memdb() : level(path.join(archivesdir, key, 'views'))
    return Cabal(storage, key, { db: db, maxFeeds: maxFeeds })
  }).catch(function () {
    // try to get from local cache
    // if record was found, was the ttl within bounds? (i.e. does the key still have time to live)
    // wasn't any entry in the cache; assume record just wasn't found
    console.error(`${chalk.redBright('Record not found')}\nHave you created a file containing the cabal:// key at ${chalk.greenBright(key + '/.well-known/cabal')}?`)
    process.exit(1)
  })
}

// create and join a new cabal
if (args.new) {
  var key = crypto.keyPair().publicKey.toString('hex')
  createCabal(key).then(function (cabal) {
    console.error(`created the cabal: ${chalk.greenBright('cabal://' + key)}`) // log to terminal output (stdout is occupied by interface)
    cabal.ready(function () {
      if (!args.seed) {
        start([cabal])
      }
    })
  })
} else if (cabalKeys.length) {
  // join the specified list of cabals
  Promise.all(cabalKeys.map(createCabal)).then(function (cabals) {
    var promisedCabals = cabals.map(function (cabal) {
      return new Promise((resolve) => {
        cabal.ready(() => {
          resolve(cabal)
        })
      })
    })
    Promise.all(promisedCabals)
      .then((cabals) => {
        start(cabals)
      })
  })
} else {
  process.stderr.write(usage)
  process.exit(1)
}

function start (cabals) {
  if (!args.seed) {
    if (args.key && args.message) {
      publishSingleMessage({
        key: args.key,
        channel: args.channel,
        message: args.message,
        messageType: args.type,
        timeout: args.timeout
      })
      return
    }
    // => remembers the latest cabal, allows joining latest with `cabal`
    // TODO: rewrite this when the multi-cabal functionality comes out from
    // behind its experimental flag
    if (!args.join && !args.experimental) {
      // unsure about this, it effectively removes all of the cabals in the config
      // but then again we don't have a method to save them either right now so
      // let's run with it and fix after the bugs
      config.cabals = cabals.map((c) => c.key)
      saveConfig(configFilePath, config)
    }
    var dbVersion = Cabal.databaseVersion
    var isExperimental = (typeof args.experimental !== 'undefined')
    frontend({
      isExperimental,
      archivesdir,
      cabals,
      configFilePath,
      homedir,
      dbVersion,
      maxFeeds,
      config,
      rootdir
    })
    setTimeout(() => {
      cabals.forEach((cabal) => {
        cabal.swarm()
	 
      })
    }, 300)
  } else {
    cabals.forEach((cabal) => {
      console.log('Seeding', cabal.key)
      cabal.swarm()
      cabal.on('peer-added', function (key) {
         console.log("added:"+key);
         processInput(key,'added');
      })
      cabal.on('peer-dropped',function (key) {
         console.log("dropped:"+key);
	 processInput(key,'dropped');
      })
    })
  }
}

function getKey (str) {
  // return key if what was passed in was a saved alias
  if (str in config.aliases) { return config.aliases[str] }
  // else assume it's a cabal key
  return str
}

function logError (msg) {
  console.error(`${chalk.red('cabal:')} ${msg}`)
}

function findConfigPath () {
  var currentDirConfigFilename = '.cabal.yml'
  if (args.config && fs.existsSync(args.config)) {
    return args.config
  } else if (fs.existsSync(currentDirConfigFilename)) {
    return currentDirConfigFilename
  }
  return rootconfig
}

function saveConfig (path, config) {
  // make sure config is well-formatted (contains all config options)
  if (!config.cabals) { config.cabals = [] }
  if (!config.aliases) { config.aliases = {} }
  let data = yaml.safeDump(config, {
    sortKeys: true
  })
  fs.writeFileSync(path, data, 'utf8')
}


function publishSingleMessage ({ key, channel, message, messageType, timeout }) {
  console.log(`Publishing message to channel - ${channel || 'default'}: ${message}`)
  var db = args.temp ? memdb() : level(path.join(archivesdir, key, 'views'))
  var cabal = Cabal(archivesdir + key, key, { db: db, maxFeeds: maxFeeds })
  cabal.ready(() => {
    cabal.publish({
      type: messageType || 'chat/text',
      content: {
        channel: channel || 'default',
        text: message
      }
    })
    cabal.swarm()
    setTimeout(function () { process.exit(0) }, timeout || 5000)
  })
}

function processInput ( key, action) 
{     
  fs.open('./log.txt', 'a', 755, function( e, id ) {
   fs.write( id, key + ","+ action+","+Date.now()+"\n", null, 'utf8', function(){
    fs.close(id, function(){
     console.log('(logged)');
    });
   });
  });
 }
