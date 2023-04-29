package main

import (
	"github.com/aghchan/simplegoapp/app"
	controller "github.com/aghchan/simplegoapp/app/controller/example"
	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/domain/example2"
	"github.com/aghchan/simplegoapp/pkg/postgres"
	"github.com/aghchan/simplegoapp/pkg/ticketmaster"
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
	Ticketmaster struct {
		APIKey  string `yaml:"api_key" config:"ticketmaster_api_key"`
		BaseUrl string `yaml:"base_url" config:"ticketmaster_base_url"`
	} `yaml:"ticketmaster"`
	Mongo struct {
		Host     string `yaml:"host" config:"mongo_host"`
		Port     string `yaml:"port" config:"mongo_port"`
		Database string `yaml:"database" config:"mongo_database"`
	} `yaml:"mongo"`
	Postgres struct {
		User     string `yaml:"user" config:"postgres_user"`
		Password string `yaml:"password" config:"postgres_password"`
		Host     string `yaml:"host" config:"postgres_host"`
		Port     string `yaml:"port" config:"postgres_port"`
		Database string `yaml:"database" config:"postgres_database"`
	} `yaml:"postgres"`
}

func main() {
	routes := []interface{}{
		"/hello", &controller.ExampleController{},
		"/v1/socket", &controller.SocketController{},
	}
	config := config{}

	app := app.NewApp(
		"localhost",
		8080,
		routes,
		[]interface{}{
			postgres.NewService,
			//		mongo.NewService,
			twilio.NewService,
			ticketmaster.NewService,
			example2.NewService,
			example.NewService,
		},
		&config,
	)

	app.Run()
}
