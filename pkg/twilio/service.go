package twilio

import (
	"github.com/twilio/twilio-go"
	openapi "github.com/twilio/twilio-go/rest/api/v2010"
)

type Service interface {
	SendSMS(phoneNumber, body string) error
}

// set twilio number in config as twilio_number
func NewService(config map[string]interface{}) Service {
	return &service{
		twilioNumber: config["twilio_number"].(string),
		client:       twilio.NewRestClient(),
	}
}

type service struct {
	twilioNumber string
	client       *twilio.RestClient
}

func (this service) SendSMS(phoneNumber, body string) error {
	params := &openapi.CreateMessageParams{}
	params.SetTo(phoneNumber)
	params.SetFrom(this.twilioNumber)
	params.SetBody(body)

	_, err := this.client.ApiV2010.CreateMessage(params)
	if err != nil {
		return err
	}

	return nil
}
