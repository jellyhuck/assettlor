---
title: Publishing documentation
---

[Documentation home](index.md)

# Publishing documentation

Documentation sources live in `docs/site/` and are built with
[MkDocs](https://www.mkdocs.org/) and the
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) theme.
The site is configured by `mkdocs.yml` at the repository root, and the pinned
Python dependencies are listed in `docs/requirements.txt`. The
[`documentation` workflow](https://github.com/jellyhuck/assettlor/blob/main/.github/workflows/documentation.yml)
builds the site with `mkdocs build --strict`, uploads the generated `site/`
directory, and deploys it with GitHub's official Pages actions.

## Preview locally

Install Python 3 and run:

```bash
npm run docs
```

The first run creates a `.venv-docs/` virtual environment and installs the
pinned dependencies; later runs reuse it and reinstall only when
`docs/requirements.txt` changes. The command starts `mkdocs serve` at
[http://127.0.0.1:8000/assettlor/](http://127.0.0.1:8000/assettlor/) and
reloads pages as you edit them. Set `PYTHON` to choose a specific interpreter.

To reproduce the CI build, including broken-link and anchor checks, run:

```bash
npm run docs:build
```

The output is written to `site/`. Extra arguments are passed to MkDocs, for
example `npm run docs -- serve --dev-addr 127.0.0.1:8080`.

## Enable GitHub Pages

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, select **GitHub Actions** as the source.
3. Merge the documentation changes into `main`, or run **documentation**
   manually from the Actions tab on `main`.
4. Follow the `github-pages` deployment URL shown in the workflow run.

Pushes to `main` that change `docs/site/`, `mkdocs.yml`,
`docs/requirements.txt`, or the workflow build and deploy
the site. Pull requests targeting `main` with those changes build and upload
an artifact for validation, without deploying. Manual runs on other branches
also build without deploying. If the `github-pages` environment requires
approval, deployment waits for its configured reviewers.

The build job has read access to repository contents and Pages metadata.
Only the deployment job receives `pages: write` and `id-token: write`.
Deployment runs are serialized per branch and do not cancel an active run.
No personal access token is needed.

## Edit or add a page

Write Markdown in `docs/site/` with YAML front matter:

```markdown
---
title: My guide
---

[Documentation home](index.md)

# My guide

Explain the task, then show a working example.
```

Link pages with relative Markdown links such as `[Configuration](configuration.md)`.
MkDocs converts these to generated page URLs, so they work in both the
repository and the published site. Strict builds fail on links to missing
pages or anchors. Add each new page to the `nav` list in `mkdocs.yml` and to
the table in `index.md`.

The `mkdocs.yml` file selects the Material theme, its light and dark palettes,
the navigation order, and the enabled Markdown extensions. Keep generated HTML
out of the repository; `site/` and `.venv-docs/` are ignored by Git. No
application build or Node dependency installation is required for the
documentation build in CI.

See GitHub's documentation for
[custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
