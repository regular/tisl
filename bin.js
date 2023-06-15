#!/usr/bin/env node
//jshint -W014
const os = require('os')
const fs = require('fs')
const {exec} = require('child_process')
const {join} = require('path')
const mkdirp = require('mkdirp')
const pull = require('pull-stream')
const defer = require('pull-defer')
const human = require('human-size')
//const git = require('./git')
const tirex = require('tirex-cli')
const {download, entries} = tirex
const getPackages = GetPackages()
const pm = require('picomatch')
const conf = require('rc')('tisl', require(join(__dirname, 'config.json')))

//console.log(conf)
//const repo='/home/regular/dev/flytta/sdks/tigitrepo'
//const {listVersions} = git(repo)

const cache = join(process.env.HOME, '.tisl')

if (conf._.length == 2) {
  const [cmd, uid] = conf._
  if (cmd == 'install' || cmd == 'i') {
    install(uid, cache, bail)
  } else usage()
} else if (conf._.length == 1) {
  const [cmd] = conf._
  if (cmd=='ls-remote') listRemote()
  else if (cmd=='ls') listLocal(cache, bail)
  else usage()
} else usage()

function normalizeVersion(v) {
  return v.split('.').map(Number).join('.')
}

function inVersionRange(range, v) {
  range = normalizeVersion(range)
  v = normalizeVersion(v)
  if (range == v) return true
  if (v.startsWith(range)) return true
  return false // TODO
}

function downloadPackageIfNeeded(dest, pkg, opts, cb) {
  const target = getTarget(dest, pkg)
  fs.exists(target, there=>{
    if (there==true) {
      console.error(`${pkg.packagePublicUid} is already installed.`)
      return cb()
    } else if (there) return cb(there)
    download(getPackageUrl(pkg), target, opts, cb)
  })
}

function installPackageAndDeps(dest, pubId, versionRange, opts, resolved, cb) {
  pull(
    getPackages(),
    pull.filter(pkg=>{
      if (pkg.packagePublicId !== pubId) return false
      if (!inVersionRange(versionRange, pkg.packageVersion)) return false
      return true
    }),
    pull.collect( (err, packages)=>{
      if (err) return cb(err)
      if (!packages.length) {
        pull(
          getPackages(),
          pull.filter(pkg=>pkg.packagePublicId == pubId),
          pull.collect( (err, candidates)=>{
            const versions = candidates.map(p=>p.packageVersion)
            return cb(new Error(`Package not found: ${pubId} ${versionRange}, candidates are: ${versions.join(' ')}`))
          })
        )
      }
      sortByVersion(packages)
      const pkg = packages.slice(-1)[0]
      resolved[pkg.packagePublicId] = pkg.packagePublicUid
      console.log(`Installing dependencies of ${pkg.packagePublicUid} ...`)
      const overrides = opts.applyOverrides && getOverrides(versionRange)
      pull(
        pull.values(pkg.dependencies),
        pull.asyncMap((dep, cb)=>{
          const publicId = dep.packagePublicId
          let versionRange = dep.versionRange
          if (overrides) {
            const override_deps = overrides.dependencies || {}
            const ov = override_deps[publicId]
            if (ov) {
              console.log(`VERSION OVERRIDE: original=${versionRange} is replaced by ${ov}`)
              versionRange = ov
            }
          }
          // deliberatly not using opts here
          // (dependants are installed unfiltered)o
          installPackageAndDeps(dest, publicId, versionRange, {trim: 1}, resolved, cb)
        }),
        pull.collect(err=>{
          if (err) return cb(err)
          const target = join(dest, 'packages', pkg.packagePublicUid.replace(/\s/g, '_'))
          downloadPackageIfNeeded(dest, pkg, opts, cb)
        })
      )
    })
  )
}

function getTarget(dest, pkg) {
  return  join(dest, pkg.packagePublicUid.replace(/\s/g, '_'))
}

function install(version, dest, cb) {
  
  const filter = pm([
    '.metadata/product.json',
    '.metadata/.tirex/package.tirex.json',
    'kernel/**',
    'kernel/**/.meta/**',
    'source/**',
    'source/**/.meta/**',
    'examples/**',
    'imports.mak'
  ])
  const trim = 1

  forEachPackage(getVersions(), (pkg, cb)=>{
    const {packageVersion, packagePublicUid} = pkg
    const packagesDir = join(dest, 'packages')
    const sdkDir = join(dest, 'sdks')
    const target = getTarget(packagesDir, pkg)
    const link = join(sdkDir, packageVersion)
    console.log(`installing to ${target}`)
    const resolved = {}
    installPackageAndDeps(packagesDir, pkg.packagePublicId, pkg.packageVersion, {trim, filter, applyOverrides: true}, resolved, err=>{
      if (err) return cb(err)
      mkdirp.sync(sdkDir)
      //fs.symlink(target, link, cb)
      const env = makeSDKEnv(packageVersion, resolved, packagesDir, (err, env)=>{
        if (err) return cb(err)
        //console.log(env)
        fs.writeFile(`${link}.env`, env, 'utf-8', cb)
      })
    })
  }, versionFilter(version), cb)
}

function normalizePacakgeName(k) {
  k = k.replace(/\./g, '')
  k = k.split('_').slice(-1)[0] // last segment in _ separeted list
  return k
}

function makeSDKEnv(version, o, packageDir, cb) {
  const entries = Object.entries(o).map( ([k,v])=>{
    k = normalizePacakgeName(k)
    k = k.toUpperCase()
    k = 'TISL_' + k
    v = `$PACKAGES/${v}`
    return [k, v]
  })

  const generic = [
    `# environment for SimpleLink SDK ${version}`,
    `PACKAGES=${packageDir}`

  ].concat(entries.map( ([k, v])=>{
    return `export ${k}=${v}`
  })).join('\n')

  const scripts = fs.readdirSync(join(__dirname, 'mkenv'))
  const script = scripts.find(filename=>{
    const vpattern = filename.split('-').slice(-1)[0]
    //console.log(vpattern)
    return version.startsWith(vpattern)
  })
  if (!script) return cb(null, generic)

  const scriptPath = join(__dirname, 'mkenv', script)
  console.log('Running', scriptPath)

  exec(scriptPath, {env: Object.fromEntries(entries)}, (err, out)=>{
    if (err) return cb(err)
    out = [generic, out].join('\n\n')
    cb(null, out)
  })
}

function getPackageUrl(pkg) {
  const platform = conf.platform || {win32: 'win', darwin: 'macos', linux: 'linux'}[os.platform]
  if (!platform) return bail(new Error('Unable to detect platform. Use --platform linux|macos|win'))
  return pkg.downloadUrl[platform]
}

function forEachPackage(source, fn, filter, cb) {
  let found = false

  pull(
    source,
    pull.filter(filter),
    pull.asyncMap( (p, cb)=>{
      console.log(p.packagePublicUid)
      console.log('===')
      found = true
      const url = getPackageUrl(p)
      if (!url) {
        console.error('No url found -- ignoring')
        return cb(null)
      }
      fn(Object.assign({}, p, {url}), cb)
    }),
    pull.onEnd(err=>{
      if (err) return cb(err)
      if (!found) return cb(new Error(`Package not found: ${uid}`))
      cb(null)
    })
  )
}

function versionFilter(version) {
  const match = pm(version)
  return p=>match(p.packageVersion)
}


function bail(err) {
  if (!err) return
  console.error(err.message)
  process.exit(1)
}

function usage() {
  console.log(`
tisl -- version manager for TI SimpleLink SDK

  tisl ls-remote
  tisl install <version>
  tisl ls
    
  tisl ls-remote

    list all installable SDK versions.
    
  tisl install <version>

    Install the specified SDK version and its dependencies
    
    <version> may be a glob expression

  tisl ls
    
    list installed SDK versions

  EXAMPLES

    tisl ls-remote

    example output:

      5.30.00.03 (CC2640R2 SDK, arm.gnu@7.2, arm.ti@18.12, xdctools@3.51.03.28)
      5.30.01.01 (CC13xx CC26xx SDK, arm.gnu@9.2, arm.ti@20.2, sysconfig@1.10.0, ti_cgt_tiarmclang@1.3.0, xdctools@3.62.01.15)
      5.40.00.40 (CC13xx CC26xx SDK, arm.gnu@9.2, arm.ti@20.2, sysconfig@1.10.0, ti_cgt_tiarmclang@1.3.0, xdctools@3.62.01.15)

    tisl ls

    example output:

      5.30.00.03
        armgnu@7.2.1 armti@18.12.5 xdctools@3.51.03.28
        supported devices: CC2640R2FRGZ CC2640R2FRHB CC2640R2FRSM

      6.40.00.13
        armgnu@9.2.1 sysconfig@1.15.0 tiarmclang@2.01.02.00 xdctools@3.62.01.15
        supported devices: CC[12][36][0-9][^0].*

      7.10.00.98
        armgnu@9.2.1 sysconfig@1.15.0 tiarmclang@1.03.00.00 xdctools@3.62.01.15
        supported devices: CC[12][36][0-9][^0].*


`)
}

function getVersions() {
  return pull(
    getPackages(),
    pull.filter(sdk_filter())
  )
}

function sdk_filter() {
  const filter = /CC2.*SDK__/
  const exclude = /ACADEMY/

  return p=>{
    if (!p.packagePublicUid.match(filter)) return false
    if (p.packagePublicUid.match(exclude)) return false
    return true
  }
}

function sortByVersion(packages) {
  packages.sort( (a,b) => a.packageVersion > b.packageVersion ? 1:-1)
}

function listRemote() {
  pull(
    getVersions(),
    pull.through(p=>{
      p.dependencies = p.dependencies.reduce( (acc, {packagePublicId, versionRange})=>{
        acc[packagePublicId] = versionRange
        return acc
      }, {})
    }),
    pull.collect( (err, packages)=>{
      bail(err)
      sortByVersion(packages)
      for(const p of packages) {
        const {packagePublicUid, packageType, packageVersion, name, dependencies} = p
        const shortname = name.replace(/SimpleLink\s*/, '')
        let details = [shortname]
        const overrides = getOverrides(packageVersion)
        const override_deps = (overrides && overrides.dependencies) || {}
        details = details.concat(Object.entries(dependencies).map( ([pid, version])=>{
          const o = override_deps[pid]
          return `${pid}@${version}${o?' (forced to ' + o + ' bv override)' : ''}`
        }))
        console.log(`  ${packageVersion} (${details.join(', ')})`)
      }
    })
  )
}

function getOverrides(version) {
  if (!conf.overrides) return
  for (const [k, v] of Object.entries(conf.overrides)) {
    if (pm(k)(version)) {
      return v
    }
  }
}

function listLocal(dest, cb) {
  const sdkDir = join(dest, 'sdks')
  fs.readdir(sdkDir, (err, files)=>{
    if (err) return cb(err)
    pull(
      pull.values(files),
      pull.filter(fn=>fn.endsWith('.env')),
      pull.asyncMap((fname, cb)=>{
        fs.readFile(join(sdkDir, fname), 'utf-8', (err, data)=>{
          if (err) return cb(err)
          cb(null, data)
        })
      }),
      pull.map(data=>{
        const lines = data.split('\n').filter(l=>l.startsWith('export '))
        return lines.map(l=>l.split('=')[1])
      }),
      pull.asyncMap( (pkgPaths, cb)=>{
        pull(
          pull.values(pkgPaths),
          // take first path segment after cache path (that's the package name)
          pull.filter(),
          pull.map(p=>p.replace(/\$PACKAGES/g, join(cache, 'packages'))),
          //pull.through(console.log),
          pull.map(p=>p[0]=='"' ? p.slice(1, p.length-1) : p),
          pull.filter(p=>p.startsWith(cache)),
          pull.map(p=>p.slice(cache.length).split('/')[2]),  // select ../packages/>NAME<
          pull.unique(),
          pull.map(p=>join(cache, 'packages', p)),
          pull.asyncMap( (path, cb)=>{
            fs.readFile(join(path, '.metadata', 'product.json'), (err, data)=>{
              if (!err) return cb(null, data)
              fs.readFile(join(path, '.metadata', '.tirex', 'package.tirex.json'), cb)
            })
          }),
          pull.asyncMap( (data, cb)=>{
            let meta
            try {
              meta = JSON.parse(data)
            } catch(err) {
              return cb(err)
            }
            cb(null, meta)
          }),
          pull.collect( (err, metas)=>{
            if (err) return cb(err)
            cb(null, metas.flat())
          })
        )
      }),
      pull.map(metas=>{
        return metas.map(m=>{
          return {name: normalizePacakgeName(m.id || m.name), version: m.version, devices: m.devices}
        })
      }),
      pull.collect( (err, sdks)=>{
        if (err) return cb(err)
        sdks.forEach(pkgs=>{
          //console.log(pkgs)
          const isMain = p=>p.name.toLowerCase() == 'sdk'
          const main = pkgs.find(isMain)
          console.log(main.version)
          const deps = pkgs.map(pkg=>{
            if (isMain(pkg)) return
            return `${pkg.name.trim()}@${pkg.version}`
          }).filter(x=>x).join(' ')
          console.log(`  ${deps}`)
          console.log('  supported devices:', [main.devices].flat().join(' ')) 
          console.log()
        })
      })
    )
  })
}

function GetPackages() {
  let cache = null

  return function() {
    if (cache) return pull.values(cache)
    const deferred = defer.source()
    
    pull(
      tirex.getPackages(),
      pull.collect( (err, data) =>{
        if (err) return deferred.resolve(pull.error(err))
        cache = data
        deferred.resolve(pull.values(data))
      })
    )

    return deferred
  }
}
