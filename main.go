package main

import (
	"github.com/aghchan/simplegoapp/app"
	controller "github.com/aghchan/simplegoapp/app/controller/example"
	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/domain/example2"
	"github.com/aghchan/simplegoapp/pkg/twilio"
)

type config struct {
	Test struct {
		Field1 string `yaml:"field1" config:"test_field1"`
		Field2 string `yaml:"field2" config:"test_field2"`
	} `yaml:"test"`
	Twilio struct {
		PhoneNumber string `yaml:"phone_number" config:"twilio_number" env:"TWILIO_PHONE_NUMBER"`
	} `yaml:"twilio"`
}

func main() {
	routes := []interface{}{
		"/hello", &controller.ExampleController{},
	}
	config := config{}

	app := app.NewApp(
		"localhost",
		8080,
		&config,
		routes,
		[]interface{}{
			twilio.NewService,
			example2.NewService,
			example.NewService,
		},
	)

	app.Run()
}
