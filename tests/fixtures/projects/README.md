Small projects for map_tokens tests, one per platform. Each defines colors, spacing, radii, and
text styles the way that platform usually does, plus components. The tests copy a project and add
a dependency folder and an .env file to the copy, which the scan must skip; git ignores both, so
they cannot live here.
