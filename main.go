package main

import (
	"github.com/aghchan/simplegoapp/app"
	controller "github.com/aghchan/simplegoapp/app/controller/example"
	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/domain/example2"
)

func main() {
	routes := []interface{}{
		"/hello", &controller.ExampleController{},
	}

	app := app.NewApp(
		"localhost",
		8080,
		routes,
		[]interface{}{
			example2.NewExample2Service,
			example.NewExampleService,
		},
	)

	app.Run()
}
