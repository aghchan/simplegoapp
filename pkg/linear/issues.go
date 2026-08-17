package linear

import (
	"context"
	"fmt"
	"strings"
)

const issueFields = `id identifier title description dueDate createdAt updatedAt state { name } project { name }`

type issueNode struct {
	Id          string  `json:"id"`
	Identifier  string  `json:"identifier"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	DueDate     *string `json:"dueDate"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	State       *struct {
		Name string `json:"name"`
	} `json:"state"`
	Project *struct {
		Name string `json:"name"`
	} `json:"project"`
}

func (this issueNode) toIssue() Issue {
	issue := Issue{
		Id:          this.Id,
		Identifier:  this.Identifier,
		Title:       this.Title,
		Description: this.Description,
		DueDate:     parseDate(this.DueDate),
		CreatedAt:   parseTimestamp(this.CreatedAt),
		UpdatedAt:   parseTimestamp(this.UpdatedAt),
	}
	if this.State != nil {
		issue.State = this.State.Name
	}
	if this.Project != nil {
		issue.Project = this.Project.Name
	}

	return issue
}

func (this *service) CreateIssue(ctx context.Context, input IssueInput) (Issue, error) {
	stateId, err := this.stateId(ctx, input.State)
	if err != nil {
		return Issue{}, err
	}

	projectId, err := this.projectId(ctx, input.Project)
	if err != nil {
		return Issue{}, err
	}

	create := map[string]interface{}{
		"teamId":      this.teamId,
		"title":       input.Title,
		"description": input.Description,
		"stateId":     stateId,
		"dueDate":     formatDate(input.DueDate),
	}
	// Only send projectId when one was asked for — an empty string would ask
	// Linear to move the issue out of any project rather than leave it alone.
	if projectId != "" {
		create["projectId"] = projectId
	}

	variables := map[string]interface{}{"input": create}

	var result struct {
		IssueCreate struct {
			Success bool      `json:"success"`
			Issue   issueNode `json:"issue"`
		} `json:"issueCreate"`
	}
	document := `mutation($input: IssueCreateInput!) {
		issueCreate(input: $input) { success issue { ` + issueFields + ` } }
	}`
	if err := this.query(ctx, document, variables, &result); err != nil {
		return Issue{}, err
	}
	if !result.IssueCreate.Success {
		return Issue{}, fmt.Errorf("linear: issue create rejected")
	}

	return result.IssueCreate.Issue.toIssue(), nil
}

func (this *service) UpdateIssue(ctx context.Context, id string, patch IssuePatch) (Issue, error) {
	input := map[string]interface{}{}
	if patch.Title != nil {
		input["title"] = *patch.Title
	}
	if patch.Description != nil {
		input["description"] = *patch.Description
	}
	if patch.DueDate != nil {
		input["dueDate"] = formatDate(patch.DueDate)
	}
	if patch.State != nil {
		stateId, err := this.stateId(ctx, *patch.State)
		if err != nil {
			return Issue{}, err
		}
		input["stateId"] = stateId
	}
	if patch.Project != nil {
		projectId, err := this.projectId(ctx, *patch.Project)
		if err != nil {
			return Issue{}, err
		}
		input["projectId"] = projectId
	}

	// an empty input would be a no-op round trip that still costs a request
	if len(input) == 0 {
		return this.Issue(ctx, id)
	}

	var result struct {
		IssueUpdate struct {
			Success bool      `json:"success"`
			Issue   issueNode `json:"issue"`
		} `json:"issueUpdate"`
	}
	document := `mutation($id: String!, $input: IssueUpdateInput!) {
		issueUpdate(id: $id, input: $input) { success issue { ` + issueFields + ` } }
	}`
	err := this.query(ctx, document, map[string]interface{}{"id": id, "input": input}, &result)
	if err != nil {
		if isMissing(err) {
			return Issue{}, ErrNotFound
		}

		return Issue{}, err
	}
	if !result.IssueUpdate.Success {
		return Issue{}, fmt.Errorf("linear: issue update rejected")
	}

	return result.IssueUpdate.Issue.toIssue(), nil
}

func (this *service) Issue(ctx context.Context, id string) (Issue, error) {
	var result struct {
		Issue *issueNode `json:"issue"`
	}
	document := `query($id: String!) { issue(id: $id) { ` + issueFields + ` } }`

	err := this.query(ctx, document, map[string]interface{}{"id": id}, &result)
	if err != nil {
		if isMissing(err) {
			return Issue{}, ErrNotFound
		}

		return Issue{}, err
	}
	if result.Issue == nil {
		return Issue{}, ErrNotFound
	}

	return result.Issue.toIssue(), nil
}

func (this *service) Issues(ctx context.Context, query IssueQuery) (IssuePage, error) {
	variables := map[string]interface{}{
		"teamId": this.teamId,
		"first":  query.Limit,
	}
	if query.Cursor != "" {
		variables["after"] = query.Cursor
	}
	if query.State != "" {
		// eqIgnoreCase: state names are stored capitalized ("Screen") while
		// the domain speaks lowercase stages
		variables["filter"] = map[string]interface{}{
			"state": map[string]interface{}{"name": map[string]interface{}{"eqIgnoreCase": query.State}},
		}
	}

	var result struct {
		Team *struct {
			Issues struct {
				Nodes    []issueNode `json:"nodes"`
				PageInfo struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"issues"`
		} `json:"team"`
	}
	document := `query($teamId: String!, $first: Int, $after: String, $filter: IssueFilter) {
		team(id: $teamId) {
			issues(first: $first, after: $after, filter: $filter) {
				nodes { ` + issueFields + ` }
				pageInfo { hasNextPage endCursor }
			}
		}
	}`
	if err := this.query(ctx, document, variables, &result); err != nil {
		return IssuePage{}, err
	}
	if result.Team == nil {
		return IssuePage{}, ErrNotFound
	}

	page := IssuePage{Issues: make([]Issue, 0, len(result.Team.Issues.Nodes))}
	for _, node := range result.Team.Issues.Nodes {
		page.Issues = append(page.Issues, node.toIssue())
	}
	if result.Team.Issues.PageInfo.HasNextPage {
		page.NextCursor = result.Team.Issues.PageInfo.EndCursor
	}

	return page, nil
}

func (this *service) CreateComment(ctx context.Context, issueId, body string) error {
	var result struct {
		CommentCreate struct {
			Success bool `json:"success"`
		} `json:"commentCreate"`
	}
	document := `mutation($input: CommentCreateInput!) {
		commentCreate(input: $input) { success }
	}`
	variables := map[string]interface{}{
		"input": map[string]interface{}{"issueId": issueId, "body": body},
	}

	err := this.query(ctx, document, variables, &result)
	if err != nil {
		if isMissing(err) {
			return ErrNotFound
		}

		return err
	}
	if !result.CommentCreate.Success {
		return fmt.Errorf("linear: comment create rejected")
	}

	return nil
}

func (this *service) Attachments(ctx context.Context, issueId string) ([]Attachment, error) {
	var result struct {
		Issue *struct {
			Attachments struct {
				Nodes []Attachment `json:"nodes"`
			} `json:"attachments"`
		} `json:"issue"`
	}
	document := `query($id: String!) { issue(id: $id) { attachments { nodes { id url title } } } }`

	err := this.query(ctx, document, map[string]interface{}{"id": issueId}, &result)
	if err != nil {
		if isMissing(err) {
			return nil, ErrNotFound
		}

		return nil, err
	}
	if result.Issue == nil {
		return nil, ErrNotFound
	}

	return result.Issue.Attachments.Nodes, nil
}

func (this *service) AttachURL(ctx context.Context, issueId, url, title string) error {
	var result struct {
		AttachmentCreate struct {
			Success bool `json:"success"`
		} `json:"attachmentCreate"`
	}
	document := `mutation($input: AttachmentCreateInput!) {
		attachmentCreate(input: $input) { success }
	}`
	variables := map[string]interface{}{
		"input": map[string]interface{}{"issueId": issueId, "url": url, "title": title},
	}

	if err := this.query(ctx, document, variables, &result); err != nil {
		if isMissing(err) {
			return ErrNotFound
		}

		return err
	}
	if !result.AttachmentCreate.Success {
		return fmt.Errorf("linear: attachment create rejected")
	}

	return nil
}

func (this *service) AttachmentsForURL(ctx context.Context, url string) ([]Attachment, error) {
	var result struct {
		AttachmentsForURL struct {
			Nodes []struct {
				Id    string `json:"id"`
				Url   string `json:"url"`
				Title string `json:"title"`
				Issue *struct {
					Id string `json:"id"`
				} `json:"issue"`
			} `json:"nodes"`
		} `json:"attachmentsForURL"`
	}
	document := `query($url: String!) { attachmentsForURL(url: $url) { nodes { id url title issue { id } } } }`

	if err := this.query(ctx, document, map[string]interface{}{"url": url}, &result); err != nil {
		return nil, err
	}

	attachments := make([]Attachment, 0, len(result.AttachmentsForURL.Nodes))
	for _, node := range result.AttachmentsForURL.Nodes {
		attachment := Attachment{Id: node.Id, Url: node.Url, Title: node.Title}
		if node.Issue != nil {
			attachment.IssueId = node.Issue.Id
		}
		attachments = append(attachments, attachment)
	}

	return attachments, nil
}

func (this *service) Comments(ctx context.Context, issueId string) ([]Comment, error) {
	var result struct {
		Issue *struct {
			Comments struct {
				Nodes []Comment `json:"nodes"`
			} `json:"comments"`
		} `json:"issue"`
	}
	document := `query($id: String!) { issue(id: $id) { comments(last: 50) { nodes { id body } } } }`

	err := this.query(ctx, document, map[string]interface{}{"id": issueId}, &result)
	if err != nil {
		if isMissing(err) {
			return nil, ErrNotFound
		}

		return nil, err
	}
	if result.Issue == nil {
		return nil, ErrNotFound
	}

	nodes := result.Issue.Comments.Nodes
	for i, j := 0, len(nodes)-1; i < j; i, j = i+1, j-1 {
		nodes[i], nodes[j] = nodes[j], nodes[i]
	}

	return nodes, nil
}

// CreateState invalidates the cached state map so a just-created state is
// immediately addressable by name.
func (this *service) CreateState(ctx context.Context, state StateInput) (string, error) {
	var result struct {
		WorkflowStateCreate struct {
			Success       bool `json:"success"`
			WorkflowState struct {
				Id string `json:"id"`
			} `json:"workflowState"`
		} `json:"workflowStateCreate"`
	}
	document := `mutation($input: WorkflowStateCreateInput!) {
		workflowStateCreate(input: $input) { success workflowState { id } }
	}`
	variables := map[string]interface{}{
		"input": map[string]interface{}{
			"teamId": this.teamId,
			"name":   state.Name,
			"type":   state.Type,
			"color":  state.Color,
		},
	}

	if err := this.query(ctx, document, variables, &result); err != nil {
		return "", err
	}
	if !result.WorkflowStateCreate.Success {
		return "", fmt.Errorf("linear: state create rejected")
	}

	this.mu.Lock()
	this.states = nil
	this.mu.Unlock()

	return result.WorkflowStateCreate.WorkflowState.Id, nil
}

func (this *service) Teams(ctx context.Context) ([]Team, error) {
	var result struct {
		Teams struct {
			Nodes []Team `json:"nodes"`
		} `json:"teams"`
	}
	document := `query { teams { nodes { id key name } } }`

	if err := this.query(ctx, document, nil, &result); err != nil {
		return nil, err
	}

	return result.Teams.Nodes, nil
}

func (this *service) StateNames(ctx context.Context) ([]string, error) {
	states, err := this.loadStates(ctx)
	if err != nil {
		return nil, err
	}

	names := make([]string, 0, len(states))
	for name := range states {
		names = append(names, name)
	}

	return names, nil
}

// stateId maps a pipeline stage onto the team's workflow state of the same
// name. The mapping is by name because the states are created by hand in
// Linear; a missing one is a setup problem, not a runtime error.
func (this *service) stateId(ctx context.Context, name string) (string, error) {
	if name == "" {
		return "", nil
	}

	states, err := this.loadStates(ctx)
	if err != nil {
		return "", err
	}

	id, ok := states[strings.ToLower(name)]
	if !ok {
		return "", fmt.Errorf("%w: no workflow state named %q in the team", ErrUnorganized, name)
	}

	return id, nil
}

// projectId maps a project name onto the team's project of the same name,
// by name for the same reason states are: projects are created by hand in
// Linear, so a missing one is a setup problem, not a runtime error.
func (this *service) projectId(ctx context.Context, name string) (string, error) {
	if name == "" {
		return "", nil
	}

	projects, err := this.loadProjects(ctx)
	if err != nil {
		return "", err
	}

	id, ok := projects[strings.ToLower(name)]
	if !ok {
		return "", fmt.Errorf("%w: no project named %q in the team", ErrUnorganized, name)
	}

	return id, nil
}

func (this *service) loadProjects(ctx context.Context) (map[string]string, error) {
	this.mu.RLock()
	cached := this.projects
	this.mu.RUnlock()
	if cached != nil {
		return cached, nil
	}

	var result struct {
		Team *struct {
			Projects struct {
				Nodes []struct {
					Id   string `json:"id"`
					Name string `json:"name"`
				} `json:"nodes"`
			} `json:"projects"`
		} `json:"team"`
	}
	document := `query($teamId: String!) {
		team(id: $teamId) { projects { nodes { id name } } }
	}`
	if err := this.query(ctx, document, map[string]interface{}{"teamId": this.teamId}, &result); err != nil {
		return nil, err
	}
	if result.Team == nil {
		return nil, fmt.Errorf("%w: team %s not found", ErrUnorganized, this.teamId)
	}

	projects := map[string]string{}
	for _, node := range result.Team.Projects.Nodes {
		projects[strings.ToLower(node.Name)] = node.Id
	}

	this.mu.Lock()
	this.projects = projects
	this.mu.Unlock()

	return projects, nil
}

func (this *service) loadStates(ctx context.Context) (map[string]string, error) {
	this.mu.RLock()
	cached := this.states
	this.mu.RUnlock()
	if cached != nil {
		return cached, nil
	}

	var result struct {
		Team *struct {
			States struct {
				Nodes []struct {
					Id   string `json:"id"`
					Name string `json:"name"`
				} `json:"nodes"`
			} `json:"states"`
		} `json:"team"`
	}
	document := `query($teamId: String!) {
		team(id: $teamId) { states { nodes { id name } } }
	}`
	if err := this.query(ctx, document, map[string]interface{}{"teamId": this.teamId}, &result); err != nil {
		return nil, err
	}
	if result.Team == nil {
		return nil, fmt.Errorf("%w: team %s not found", ErrUnorganized, this.teamId)
	}

	states := map[string]string{}
	for _, node := range result.Team.States.Nodes {
		states[strings.ToLower(node.Name)] = node.Id
	}

	this.mu.Lock()
	this.states = states
	this.mu.Unlock()

	return states, nil
}

// Linear reports a missing entity as a GraphQL error rather than a null node
// in some cases, so both shapes have to be treated as not-found.
func isMissing(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "entity not found")
}
