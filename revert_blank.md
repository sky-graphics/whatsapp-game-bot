# Revert Blank Workflow

This document describes the stable workflow for using a blank state and returning to your normal commit.

## 1. Keep a saved blank state
Use a tag to preserve the blank commit:

```bash
git tag -f blank-state HEAD
git push --tags blank
```

## 2. Push the blank state
When you need the repository on GitHub to be blank:

```bash
git checkout blank-state
git push --force blank HEAD:main
```

## 3. Return to normal code
When you need the previous commit back:

```bash
git checkout main
git push --force blank main
```

If `main` is not already at the normal commit:

```bash
git reset --hard <normal-commit-hash>
git push --force blank main
```

## 4. Confirm your state
Before pushing, verify:

```bash
git branch --show-current
git log --oneline --decorate -n 3
git status --short
```

## Summary
- `blank-state` is your saved blank fallback
- `git checkout blank-state && git push --force blank HEAD:main` = push blank
- `git checkout main && git push --force blank main` = restore normal
- always confirm branch and history before forcing a push
