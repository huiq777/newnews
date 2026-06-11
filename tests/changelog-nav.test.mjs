import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('changelog includes Deep Analysis launch entry', () => {
  const changelog = read('news-app/lib/changelog.ts')
  assert.match(changelog, /Deep Analysis/)
  assert.match(changelog, /2026-06-10/)
})

test('login, github repo, and news log buttons are ordered correctly', () => {
  const nav = read('news-app/components/NavBar.tsx')
  assert.match(nav, /LoginActionButton/)
  assert.match(nav, /nativeID="github-repo-btn"/)
  assert.match(nav, /nativeID="whats-new-btn"/)
  assert.ok(nav.indexOf('LoginActionButton') < nav.indexOf('nativeID="github-repo-btn"'))
  assert.ok(nav.indexOf('nativeID="github-repo-btn"') < nav.indexOf('nativeID="whats-new-btn"'))
  assert.match(nav, /GITHUB_STARS_LABEL/)
  assert.match(nav, /fa-solid fa-star/)
})
