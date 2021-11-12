package example2

import (
	"go.uber.org/zap"

	"github.com/aghchan/simplegoapp/domain/example"
)

func NewService(
	logger *zap.SugaredLogger,
	exampleService example.Service,
) Service {
	return &service{
		logger:         logger,
		example: exampleService,
	}
}

type Service interface {
	Yes()
}

type service struct {
	logger *zap.SugaredLogger

	example example.Service
}

func (this service) Yes() {
	this.example.Hello()
}
