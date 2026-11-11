#!/usr/bin/env bash
# Publishes this repository to the owner's GitHub account, PRIVATE by default.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v git >/dev/null 2>&1; then
  echo 'Git não encontrado. Instale Git antes de publicar.' >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo 'GitHub CLI (gh) não encontrado. Instale com: brew install gh' >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo 'Você precisa entrar na sua conta GitHub. Execute: gh auth login' >&2
  exit 1
fi

OWNER='guisba'
REPO='veil-p2p'
CURRENT="$(gh api user --jq '.login')"
if [ "$CURRENT" != "$OWNER" ]; then
  echo "Conectado como $CURRENT, mas o destino esperado é $OWNER. Nenhum envio realizado." >&2
  exit 1
fi
if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "Já existe um repositório em https://github.com/$OWNER/$REPO. Não farei alterações sem revisão." >&2
  exit 1
fi

git init -q
if ! git config user.name >/dev/null 2>&1; then git config user.name "$CURRENT"; fi
if ! git config user.email >/dev/null 2>&1; then
  ID="$(gh api user --jq '.id')"
  git config user.email "${ID}+${CURRENT}@users.noreply.github.com"
fi

git add .
if ! git diff --cached --quiet; then
  git commit -m 'Initial import: VEIL v2.2 P2P Privacy & QR'
fi
git branch -M main

gh repo create "$OWNER/$REPO" \
  --private \
  --source=. \
  --remote=origin \
  --push \
  --description='VEIL P2P — local-first encrypted WebRTC messenger with QR invitations'

echo ''
echo 'Repositório criado com visibilidade privada:'
gh repo view "$OWNER/$REPO" --json url,visibility --jq '"\(.url) (\(.visibility))"'
