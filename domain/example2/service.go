package example2

import (
	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/pkg/logger"
)

func NewService(
	logger logger.Logger,
	exampleService example.Service,
) Service {
	return &service{
		logger:  logger,
		example: exampleService,
	}
}

type Service interface {
	Yes()
}

type service struct {
	logger logger.Logger

	example example.Service
}

func (this service) Yes() {
	this.example.Hello()
}
