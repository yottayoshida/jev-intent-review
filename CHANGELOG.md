# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- The groundwork for the command line tool: it reads the change between two commits from git
  objects, never from the working tree's files or `.gitattributes`, and passes every diff setting
  explicitly so git config does not change what is read. It finds the function around each
  changed line and the calls made around it, loads `.jev-intent-review.yml` from the commit
  before the change, reads requirements from `--intent-spec`, and renders the report as Markdown
  or JSON. A Jev client for Workers AI is included, with retries and a request, byte and time
  budget counted on what is actually sent; `npm run probe:jev` uses it to ask the real model. The
  command line does not call it yet. Requirement verification itself is not in this build: every
  requirement is reported as unknown and the run exits 2.
