# Release Workflow

## 🚀 Proper Release Process

**IMPORTANT**: This project uses GitHub Actions for automated releases. Follow this exact process to ensure releases include compiled files.

### Step 1: Version Updates
```bash
# Update version files
npm run version  # OR manually update manifest.json, package.json, versions.json
npm run build    # Ensure local build works

# Commit version changes
git add manifest.json package.json versions.json
git commit -m "chore: bump version to X.Y.Z"
```

### Step 2: Create and Push Tag
```bash
# Create tag WITHOUT 'v' prefix (important!)
git tag X.Y.Z
git push origin master
git push origin X.Y.Z
```

### Step 3: Handle GitHub Actions
- GitHub Actions will automatically trigger on tag push
- It will build the project and attempt to create a draft release
- **DO NOT create manual releases** - this conflicts with automation

### Step 4: Verify and Fix Release
```bash
# Check if Actions completed successfully
gh run list --limit 3

# Check current releases
gh release list --limit 5

# If release is missing compiled files, upload them manually:
gh release upload X.Y.Z main.js manifest.json styles.css

# Verify files are attached
gh release view X.Y.Z --json assets --jq '.assets[].name'
```

### Step 5: Clean Up Draft Releases
```bash
# Remove any duplicate or incorrect draft releases
gh release list | grep "Draft"
gh api repos/byheaven/search-in-newtab/releases | jq -r '.[] | select(.draft == true and .tag_name == "X.Y.Z") | .url' | head -1
# Use the URL to delete: gh api -X DELETE [URL]
```

## ⚠️ Common Issues and Solutions

**Problem**: Release created without compiled files
- **Cause**: Manual release creation conflicts with GitHub Actions
- **Solution**: Always use `gh release upload` to add missing files

**Problem**: Wrong tag format (v1.4.1 instead of 1.4.1)
- **Cause**: Using 'v' prefix in tag name
- **Solution**: Delete wrong tag, create correct one without 'v'

**Problem**: Multiple draft releases
- **Cause**: Actions workflow conflicts
- **Solution**: Clean up drafts, keep only the published release

## 📋 Release Checklist
- [ ] Version updated in all files (manifest.json, package.json, versions.json)
- [ ] Local build successful (`npm run build`)
- [ ] Version committed to git
- [ ] Tag created with correct format (no 'v' prefix)
- [ ] Tag pushed to GitHub
- [ ] GitHub Actions completed successfully
- [ ] Release contains all required files (main.js, manifest.json, styles.css)
- [ ] Draft releases cleaned up

## GitHub Actions Workflow

The project uses `.github/workflows/release.yml` which:
1. Triggers on any tag push
2. Sets up Node.js environment
3. Installs dependencies and builds the project
4. Creates a draft release with compiled files

If the workflow fails or creates incorrect releases, manually fix using the steps above.