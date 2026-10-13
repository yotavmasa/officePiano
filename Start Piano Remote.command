#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v python3 >/dev/null; then
  print 'Python 3 is needed to run Piano Remote.'
  read '?Press Return to close.'
  exit 1
fi
if [[ -x .venv/bin/python ]]; then
  .venv/bin/python server.py
else
  python3 server.py
fi
if [[ $? -ne 0 ]]; then
  read '?Piano Remote stopped with an error. Press Return to close.'
fi
