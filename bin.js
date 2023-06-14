#!/usr/bin/env node
//jshint -W014
const os = require('os')
const fs = require('fs')
const {join} = require('path')
const pull = require('pull-stream')
const human = require('human-size')
//const git = require('./git')
const {getPackages, download, entries} = require('../tirex')
const pm = require('picomatch')
const conf = require('rc')('tisl')

console.log(conf)
//const repo='/home/regular/dev/flytta/sdks/tigitrepo'
//const {listVersions} = git(repo)

const cache = join(process.env.HOME, '.tisl', 'cache')

if (conf._.length == 2) {
  const [cmd, uid] = conf._
  if (cmd == 'install' || cmd == 'i') {
    install(uid, join(cache, 'sdks'), bail)
  } else usage()
} else if (conf._.length == 1) {
  const [cmd] = conf._
  if (cmd=='ls-remote') list()
  else usage()
} else usage()

function install(version, dest, cb) {
  
  const filter = pm([
    '.metadata/product.json',
    'kernel/**',
    'source/**',
    'examples/**',
  ])
  const trim = 1

  doRemote(({url, packageVersion}, cb)=>{
    const d = join(dest, packageVersion)
    console.log(d)
    fs.exists(d, there=>{
      if (there) {
        console.error(`SDK ${packageVersion} already installed.`)
        return cb()
      }
      download(url, d, {filter, trim}, cb)
    })
  }, version, cb)
}

function files(uid, cb) {
  doRemote(({url}, cb)=>{
    entries(url, (err, directory)=>{
      if (err) return cb(err)
      for(const {type, path, uncompressedSize} of directory.files) {
        const p = path.split('/').slice(1).join('/')
        const t = type[0]
        const s = uncompressedSize
        console.log(t, p, t=='F' ? s : '')
      }
      cb(null)
    })
  }, uid, cb)
}

function doRemote(fn, version, cb) {
  const platform = conf.platform || {win32: 'win', darwin: 'macos', linux: 'linux'}[os.platform]
  if (!platform) return cb(new Error('Unable to detect platform. Use --platform linux|macos|win'))
  let found = false
  const match = pm(version)

  pull(
    getVersions(),
    pull.filter(p=>match(p.packageVersion)),
    pull.asyncMap( (p, cb)=>{
      console.log(p.packagePublicUid)
      console.log('===')
      found = true
      const url = p.downloadUrl[platform]
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

function bail(err) {
  if (!err) return
  console.error(err.message)
  process.exit(1)
}

function usage() {
  console.log(`
  tisl list
  tisl files UID
  tisl download UID DEST
    
  tisl list [--friendly] [--filter_uid PATTERN [ --filter_uid PATTERN ...]]

    list all downloadable packages.
    --friendly    Print friendly names instead of UIDs.
    --filter_uid  can be specified multiple times. If given, only package
      UIDs that math the pattern are printed.

  tisl files UID

    list package contents

    UID may be a glob expression

  tisl install UID DIR

    Install the specified package to directory DIR
    
    UID may be a glob expression
  `)
}

function getVersions() {
  const filter = /CC2.*SDK__/
  const exclude = /ACADEMY/

  return pull(
    getPackages(),
    pull.filter(p=>{
      if (!p.packagePublicUid.match(filter)) return false
      if (p.packagePublicUid.match(exclude)) return false
      return true
    })
  )
}

function list() {
  pull(
    getVersions(),
    pull.collect( (err, packages)=>{
      bail(err)
      packages.sort( (a,b) => a.packageVersion > b.packageVersion ? 1:-1)
      for(const p of packages) {
        const {packagePublicUid, packageType, packageVersion, name, dependencies} = p
        const shortname = name.replace(/SimpleLink\s*/, '')
        let details = [shortname]
        if (conf.deps) {
          details = details.concat(dependencies.map(({packagePublicId, versionRange})=>`${packagePublicId}@${versionRange}`))
        }
        console.log(`  ${packageVersion} (${details.join(', ')})`)
      }
    })
  )
}
