#!/usr/bin/env node
//jshint -W014
const os = require('os')
const pull = require('pull-stream')
const human = require('human-size')
//const git = require('./git')
const {getPackages, download, entries} = require('../tirex')
const pm = require('picomatch')
const conf = require('rc')('tisl')

console.log(conf)
//const repo='/home/regular/dev/flytta/sdks/tigitrepo'
//const {listVersions} = git(repo)
if (conf._.length == 3) {
  const [cmd, uid, dest] = conf._
  if (cmd == 'install' || cmd == 'i') {
    install(uid, dest, bail)
  }
} else if (conf._.length == 2) {
  const [cmd, uid] = conf._
  if (cmd == 'files') {
    files(uid, bail)
  }
} else if (conf._.length == 1) {
  const [cmd] = conf._
  if (cmd=='list') list()
  else usage()
}

function install(uid, dest, cb) {
  
  const filter = pm([
    '.metadata/**/*',
    '*/kernel/**',
    '*/source/**',
    '*/examples/**',
    '**/imports.mak'
  ])


  doRemote((url, cb)=>{
    download(url, dest, {filter}, cb)
  }, uid, cb)
}

function files(uid, cb) {
  doRemote((url, cb)=>{
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

function doRemote(fn, uid, cb) {
  const match = pm(uid)
  const platform = conf.platform || {win32: 'win', darwin: 'macos', linux: 'linux'}[os.platform]
  if (!platform) return cb(new Error('Unable to detect platform. Use --platform linux|macos|win'))
  let found = false

  pull(
    getPackages(),
    pull.filter(p=>match(p.packagePublicUid)),
    pull.asyncMap( (p, cb)=>{
      console.log()
      console.log(p.packagePublicUid)
      console.error(p.packagePublicUid)
      console.log('===')
      found = true
      const url = p.downloadUrl[platform]
      console.error(url)
      if (!url) {
        console.error('No url found -- ignoring')
        return cb(null)
      }
      fn(url, cb)
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

function getVersions(version, cb) {
  const filter = /CC2.*SDK__/
  const exclude = /ACADEMY/

  const versionFilter = version
    ? pull.filter(p=>p.packageVersion == version)
    : pull.through()

  pull(
    getPackages(),
    versionFilter,
    pull.filter(p=>{
      if (!p.packagePublicUid.match(filter)) return false
      if (p.packagePublicUid.match(exclude)) return false
      return true
    }),
    pull.collect( (err, packages)=>{
      if (err) return cb(err)
      packages.sort( (a,b) => a.packageVersion > b.packageVersion ? 1:-1)
      cb(null, packages)
    })
  )
}

function list(version) {
  getVersions(version, (err, packages)=>{
    bail(err)
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
}
