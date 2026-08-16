package gmail

import "context"

// searchPageCap bounds runaway queries; the agent's filtered searches return
// far fewer than this.
const searchPageCap = 10

func (this *service) Search(ctx context.Context, query string) ([]MessageRef, error) {
	refs := []MessageRef{}
	pageToken := ""
	for page := 0; page < searchPageCap; page++ {
		call := this.api.Users.Messages.List("me").Q(query).Context(ctx)
		if pageToken != "" {
			call = call.PageToken(pageToken)
		}
		response, err := call.Do()
		if err != nil {
			this.logger.Error("gmail search", "error", err, "query", query)

			return nil, err
		}

		for _, message := range response.Messages {
			refs = append(refs, MessageRef{Id: message.Id, ThreadId: message.ThreadId})
		}
		if response.NextPageToken == "" {
			break
		}
		pageToken = response.NextPageToken
	}

	return refs, nil
}
