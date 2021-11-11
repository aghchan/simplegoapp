package main

import (
	"github.com/aghchan/simplegoapp/app"
	controller "github.com/aghchan/simplegoapp/app/controller/example"
	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/domain/example2"
)

type config struct {
	Test struct {
		Field1 string `yaml:"field1"`
		Field2 string `yaml:"field2"`
	} `yaml:"test"`
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
			example2.NewExample2Service,
			example.NewExampleService,
		},
	)

	app.Run()
}
