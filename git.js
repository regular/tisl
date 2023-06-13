const {spawn} = require('child_process')
const pull = require('pull-stream')
const toPull = require('stream-to-pull-stream')
const split = require('pull-split')
const utf8 = require('pull-utf8-decoder')

module.exports = function(repo) {

  function listVersions() {
    const git = spawn('git', [
      'tag',
      '--list',
      '*_sdk_*',
      '--format=%(creatordate:short) %(objectname:short=7) %(ahead-behind:HEAD) %(refname:lstrip=-1)',
      '--sort=authordate',
    ], {
      cwd: repo
    })
    return pull(
      toPull.source(git.stdout),
      utf8(),
      split(),
      pull.filter(),
      // 2023-01-26 97c5a1f 0 9 4Q22_cc13xx_cc26xx_sdk_6_40_00_13
      pull.map(line=>{
        const [date, commit, ahead, behind, tagname] = line.split(' ')
        const name = tagname.replace(/^\dQ\d\d_/, '')
        let version = name.match(/.*sdk_(\d+)_(\d+)_(\d+)_(\d+).*/)
        if (version) version = version.slice(1).join('.')
        return {date, commit, ahead, behind, name, version, tagname}
      })
    )
  }

  return {
    listVersions
  }
}

