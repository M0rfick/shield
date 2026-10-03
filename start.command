#!/bin/sh
cd "$(dirname "$0")" || exit 1
python3 -u bot.py
printf '\nНажми Enter, чтобы закрыть окно. '
read answer
