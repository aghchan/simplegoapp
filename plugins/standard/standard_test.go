package standard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

const (
	hookPath      = "hooks/session-start"
	skillPath     = "skills/system-design/SKILL.md"
	templatePath  = "skills/system-design/template.md"
	lensDir       = "skills/system-design/lenses"
	challengeFile = "_challenge.md"
	rosterPath    = "../../basetobase/config/basetobase.json"
	maxLensLines  = 40
)

type hookOutput struct {
	HookSpecificOutput struct {
		HookEventName     string `json:"hookEventName"`
		AdditionalContext string `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

// runHook runs the hook script with CLAUDE_PLUGIN_ROOT set to root and returns the parsed context
func runHook(t *testing.T, script, root string) string {
	t.Helper()

	var stdout, stderr bytes.Buffer
	cmd := exec.Command("bash", script)
	cmd.Env = append(os.Environ(), "CLAUDE_PLUGIN_ROOT="+root)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("hook failed: %v\nstderr: %s", err, stderr.String())
	}

	var out hookOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		t.Fatalf("hook output is not JSON: %v\n%s", err, stdout.String())
	}
	if got := out.HookSpecificOutput.HookEventName; got != "SessionStart" {
		t.Errorf("hookEventName = %q, want SessionStart", got)
	}
	return out.HookSpecificOutput.AdditionalContext
}

// tempPlugin returns a plugin root holding a copy of the hook, and rules.md when rules is non-nil
func tempPlugin(t *testing.T, rules *string) string {
	t.Helper()

	hook, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, hookPath), hook, 0o755); err != nil {
		t.Fatal(err)
	}
	if rules != nil {
		if err := os.WriteFile(filepath.Join(root, "rules.md"), []byte(*rules), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestSessionStartEmitsRules(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	rules, err := os.ReadFile("rules.md")
	if err != nil {
		t.Fatal(err)
	}

	got := runHook(t, hookPath, root)

	if got != string(rules) {
		t.Errorf("context = %q, want rules.md %q", got, rules)
	}
}

func TestSessionStartEscapes(t *testing.T) {
	rules := "a \"quote\" \\ back\tslash\nnew line\r\ncarriage return"
	root := tempPlugin(t, &rules)

	got := runHook(t, filepath.Join(root, hookPath), root)

	if got != rules {
		t.Errorf("context = %q, want %q", got, rules)
	}
}

func TestSessionStartWithoutRules(t *testing.T) {
	root := tempPlugin(t, nil)

	got := runHook(t, filepath.Join(root, hookPath), root)

	if want := "standard plugin: rules.md missing"; got != want {
		t.Errorf("context = %q, want %q", got, want)
	}
}

func TestRulesStateTheStandard(t *testing.T) {
	data, err := os.ReadFile("rules.md")
	if err != nil {
		t.Fatal(err)
	}
	rules := string(data)

	for _, want := range []string{
		"A simple bug fix makes the code do what it already promised, by a test, a doc, a spec or an API contract. " +
			"It changes no API contract, no database schema, no config keys, no dependencies and no infrastructure.",
		"`standard:system-design`",
		"`superpowers:brainstorming`",
		"`Design: <path>`",
		"`Design: <path> §<n>`",
		"`Fixes: <path>`",
		"bypass",
	} {
		if !strings.Contains(rules, want) {
			t.Errorf("rules.md lacks %q", want)
		}
	}

	if n := strings.Count(rules, "\n"); n > 40 {
		t.Errorf("rules.md has %d lines, the house style allows 40", n)
	}
}

func TestTemplateSections(t *testing.T) {
	data, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatal(err)
	}

	var header, headings []string
	for _, line := range strings.Split(string(data), "\n") {
		if heading, ok := strings.CutPrefix(line, "## "); ok {
			headings = append(headings, heading)
		} else if len(headings) == 0 {
			header = append(header, line)
		}
	}

	// The lenses cite these headings by their exact text
	want := []string{
		"What we're building",
		"Why",
		"Goals, non-goals, anti-goals",
		"Fit with existing features",
		"API contract",
		"Data model and migrations",
		"Scaling",
		"Infrastructure and dependencies",
		"Security",
		"Failure and rollback",
		"How we'll know it works",
		"Approaches",
		"Delivery",
		"Decisions",
		"Left to the builder",
		"Design review",
	}
	if !slices.Equal(headings, want) {
		t.Errorf("template headings = %q, want %q", headings, want)
	}

	for _, field := range []struct {
		label  string
		values []string
	}{
		{"Size:", []string{"full", "short"}},
		{"Status:", []string{"draft", "in review", "approved YYYY-MM-DD"}},
		{"From:", nil},
	} {
		i := slices.IndexFunc(header, func(line string) bool {
			return strings.Contains(line, field.label)
		})
		if i < 0 {
			t.Errorf("template header lacks %q", field.label)
			continue
		}
		for _, value := range field.values {
			if !strings.Contains(header[i], value) {
				t.Errorf("template header line %q lacks %q", header[i], value)
			}
		}
	}
}

// lens is one design lens: the roster role it speaks for, the line it starts with and its challenge id prefix
type lens struct {
	id, head, prefix string
}

// lenses returns the builder plus every roster role but the implementer, which reviews no design
func lenses(t *testing.T) []lens {
	t.Helper()

	data, err := os.ReadFile(rosterPath)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Roster []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Role   string `json:"role"`
			Prefix string `json:"prefix"`
		} `json:"roster"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Roster) == 0 {
		t.Fatalf("%s has no roster", rosterPath)
	}

	found := []lens{{id: "builder", head: "Lens: Builder — Plannability", prefix: "BLD"}}
	for _, role := range config.Roster {
		if role.ID == "groomer" {
			continue
		}
		found = append(found, lens{id: role.ID, head: "Lens: " + role.Name + " — " + role.Role, prefix: role.Prefix})
	}
	return found
}

func readLens(t *testing.T, file string) string {
	t.Helper()

	data, err := os.ReadFile(filepath.Join(lensDir, file))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func nonEmptyLines(text string) []string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func TestLensPerRole(t *testing.T) {
	for _, l := range lenses(t) {
		if _, err := os.Stat(filepath.Join(lensDir, l.id+".md")); err != nil {
			t.Errorf("no lens for %s: %v", l.id, err)
		}
	}
}

func TestLensStyle(t *testing.T) {
	byFile := map[string]lens{}
	for _, l := range lenses(t) {
		byFile[l.id+".md"] = l
	}

	files, err := os.ReadDir(lensDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		name := file.Name()
		text := readLens(t, name)
		lines := nonEmptyLines(text)

		if len(lines) > maxLensLines {
			t.Errorf("%s has %d non-empty lines, the house style allows %d", name, len(lines), maxLensLines)
		}
		if name == challengeFile {
			continue
		}

		l, ok := byFile[name]
		if !ok {
			t.Errorf("%s is neither the builder nor a roster role's lens", name)
			continue
		}
		if head, _, _ := strings.Cut(text, "\n"); head != l.head {
			t.Errorf("%s starts with %q, want %q", name, head, l.head)
		}
		// Task 5 parses role and challenge ids against the roster, so each lens states its own
		if want := fmt.Sprintf("Role id: %s. Challenge ids: %s-<n>.", l.id, l.prefix); !slices.Contains(lines, want) {
			t.Errorf("%s lacks the line %q", name, want)
		}
	}
}

func TestChallengeContract(t *testing.T) {
	contract := readLens(t, challengeFile)

	for _, want := range []string{
		// the object and a challenge, with the length limits on the free-text fields
		`"role":`, `"revision":`, `"status":`, `"challenges":`,
		`"summary":"<≤1000`,
		`"id":"<PREFIX>-<n>"`, `"section":`, `"kind":`,
		`"title":"<≤120`,
		`"detail":"<≤4000`,
		`"reply":`,
		`"clear"`,
		"`unspecified`", "`flaw`", "`defend`",
		// the skill names each lens's next free id, since a lens cannot see its own closed numbers
		"`Next id`",
	} {
		if !strings.Contains(contract, want) {
			t.Errorf("%s lacks %q", challengeFile, want)
		}
	}
}

func TestGoBlock(t *testing.T) {
	_, rest, found := strings.Cut(readLens(t, "corduroy.md"), "\n## Go\n")
	if !found {
		t.Fatal("corduroy.md has no ## Go block")
	}
	block, _, _ := strings.Cut(rest, "\n## ")

	for _, want := range []string{"domain/", "api/", "pkg/http", "apierror", "app/", "main.go"} {
		if !strings.Contains(block, want) {
			t.Errorf("corduroy.md's Go block lacks %q", want)
		}
	}
}

var (
	pluginPath = regexp.MustCompile("\\$\\{CLAUDE_PLUGIN_ROOT\\}/([^\\s`]+)")
	codeSpan   = regexp.MustCompile("`([^`]+)`")
	quoted     = regexp.MustCompile(`"([^"]+)"`)
)

func TestSkillReferences(t *testing.T) {
	data, err := os.ReadFile(skillPath)
	if err != nil {
		t.Fatal(err)
	}
	front, body, found := strings.Cut(strings.TrimPrefix(string(data), "---\n"), "\n---\n")
	if !found || !strings.HasPrefix(string(data), "---\n") {
		t.Fatalf("%s has no frontmatter", skillPath)
	}

	fields := strings.Split(front, "\n")
	if !slices.Contains(fields, "name: system-design") {
		t.Errorf("%s frontmatter %q lacks name: system-design", skillPath, front)
	}
	if !slices.ContainsFunc(fields, func(field string) bool {
		return strings.HasPrefix(field, "description: Use after the what and why are agreed")
	}) {
		t.Errorf("%s description does not start %q", skillPath, "Use after the what and why are agreed")
	}

	lensIDs := []string{}
	for _, l := range lenses(t) {
		lensIDs = append(lensIDs, l.id)
	}

	// Lens subagents get these paths, so each must resolve inside the plugin; <id> stands for every lens
	paths := pluginPath.FindAllStringSubmatch(body, -1)
	if len(paths) == 0 {
		t.Errorf("%s names no ${CLAUDE_PLUGIN_ROOT} path", skillPath)
	}
	for _, match := range paths {
		resolved := []string{strings.TrimRight(match[1], ".,;:)")}
		if strings.Contains(resolved[0], "<id>") {
			pattern := resolved[0]
			resolved = nil
			for _, id := range lensIDs {
				resolved = append(resolved, strings.ReplaceAll(pattern, "<id>", id))
			}
		}
		for _, path := range resolved {
			if _, err := os.Stat(path); err != nil {
				t.Errorf("%s names %s: %v", skillPath, match[0], err)
			}
		}
	}

	for _, want := range []string{
		"${CLAUDE_PLUGIN_ROOT}/" + templatePath,
		"${CLAUDE_PLUGIN_ROOT}/" + lensDir + "/" + challengeFile,
		"${CLAUDE_PLUGIN_ROOT}/rules.md",
		// names the bypassed PR whose owed design this clears
		"`For: #<n>`",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("%s lacks %q", skillPath, want)
		}
	}

	template, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatal(err)
	}
	headings := []string{"None"}
	for _, line := range strings.Split(string(template), "\n") {
		if heading, ok := strings.CutPrefix(line, "## "); ok {
			headings = append(headings, heading)
		}
	}

	lines := strings.Split(body, "\n")

	// Lens subagents are stateless, so the sweep and the re-check each name the next free challenge id
	prompts := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "- Prompt each:") {
			prompts++
			if !strings.Contains(line, "Next id: <PREFIX>-<n>.") {
				t.Errorf("%s prompt %q lacks %q", skillPath, line, "Next id: <PREFIX>-<n>.")
			}
		}
	}
	if prompts != 2 {
		t.Errorf("%s has %d dispatch prompts, want the sweep's and the re-check's", skillPath, prompts)
	}

	// The panel lines name lenses by role id and sections by heading, so a typo leaves a lens off the panel
	for _, rule := range []struct {
		label string
		want  []string
	}{
		{"- Full panel:", []string{"every lens", "`magic-carpet`", "`bluebird`", "screen"}},
		{"- Short panel:", []string{"`granite-chief`", `"None"`}},
		{"- A lens's section:", []string{"`corduroy`", "`summit-six`", "`gold-coast`", "`kt-22`", "`mainline`"}},
		{"- Every panel:", []string{"`builder`"}},
	} {
		i := slices.IndexFunc(lines, func(line string) bool {
			return strings.HasPrefix(line, rule.label)
		})
		if i < 0 {
			t.Errorf("%s lacks a line starting %q", skillPath, rule.label)
			continue
		}
		for _, want := range rule.want {
			if !strings.Contains(lines[i], want) {
				t.Errorf("%s line %q lacks %q", skillPath, lines[i], want)
			}
		}
		for _, span := range codeSpan.FindAllStringSubmatch(lines[i], -1) {
			if !slices.Contains(lensIDs, span[1]) {
				t.Errorf("%s line %q names %q, which is no lens", skillPath, lines[i], span[1])
			}
		}
		for _, quote := range quoted.FindAllStringSubmatch(lines[i], -1) {
			if !slices.Contains(headings, quote[1]) {
				t.Errorf("%s line %q names %q, which is no template heading", skillPath, lines[i], quote[1])
			}
		}
	}
}
