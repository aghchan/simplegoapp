package main

import (
	"simplegoapp/app"
	controller "simplegoapp/app/controller/example"
	"simplegoapp/domain/example"
	"simplegoapp/domain/example2"
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
