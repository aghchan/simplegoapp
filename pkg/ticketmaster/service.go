package ticketmaster

import (
	"github.com/aghchan/simplegoapp/pkg/http"
)

type Service interface {
	FindEvents(query FindEventsQuery) (FindEventsResponse, error)
}

func NewService(config map[string]interface{}) Service {
	return &service{
		apiKey:  config["ticketmaster_api_key"].(string),
		baseUrl: config["ticketmaster_base_url"].(string),
	}
}

type service struct {
	apiKey  string
	baseUrl string
}

func (this service) FindEvents(query FindEventsQuery) (FindEventsResponse, error) {
	params := map[string]interface{}{
		"apikey": this.apiKey,
	}

	if query.Zipcode != "" {
		params["zipcode"] = query.Zipcode
	}

	resp := &FindEventsResponse{}

	err := http.GET(this.baseUrl+"/discovery/v2/events", params, resp)
	if err != nil {
		return FindEventsResponse{}, err
	}

	return *resp, nil
}
