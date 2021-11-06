package example2

import (
	"simplegoapp/domain/example"

	"go.uber.org/zap"
)

func NewExample2Service(
	logger *zap.SugaredLogger,
	exampleService example.ExampleService,
) Example2Service {
	return &example2Service{
		logger:         logger,
		exampleService: exampleService,
	}
}

type Example2Service interface {
	Yes()
}

type example2Service struct {
	logger *zap.SugaredLogger

	exampleService example.ExampleService
}

func (this example2Service) Yes() {
	this.exampleService.Hello()
}
