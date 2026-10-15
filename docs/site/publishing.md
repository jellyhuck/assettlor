---
title: Publishing documentation
---

[Documentation home](index.md)

# Publishing documentation

Documentation sources live in `docs/site/`. The
[`documentation` workflow](https://github.com/jellyhuck/assettlor/blob/main/.github/workflows/documentation.yml)
uses GitHub's official Pages actions to build Markdown with Jekyll, upload
the generated `_site/` directory, and deploy it to GitHub Pages.

## Enable GitHub Pages

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, select **GitHub Actions** as the source.
3. Merge the documentation changes into `main`, or run **documentation**
   manually from the Actions tab on `main`.
4. Follow the `github-pages` deployment URL shown in the workflow run.

Pushes to `main` that change `docs/site/` or the workflow build and deploy
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
The `jekyll-relative-links` plugin converts these to generated page URLs,
so they work in both the repository and the published site. Add new guides
to the table in `index.md`.

The `_config.yml` file selects the Primer theme and the default page layout.
Keep generated HTML out of the source directory; the workflow creates it
as a deployment artifact. No application build or Node dependency installation
is required for the documentation build.

See GitHub's documentation for
[custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
